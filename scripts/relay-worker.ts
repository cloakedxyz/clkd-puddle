import { mkdir, open, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Contract, Interface, JsonRpcProvider, Transaction, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import type { Signer } from 'ethers';
import { createRailgunAdapter, inspectDeposit, parseRecoveryFile, recoveryRecord, verifyDeployment } from '../sdk/index.ts';
import type { Deployment, DepositExecution, RecoveryArtifacts, RecoveryFile } from '../sdk/index.ts';
import { executorABI, initialData, validateQuote } from '../sdk/kernel.ts';

export interface RelayPolicy {
  feeRecipient: string;
  minAmount: bigint;
  maxAmount: bigint;
  maxNativeFee: bigint;
  maxTotalNativeSpend: bigint;
  confirmations: number;
  maxJobs: number;
}
type Status = 'waiting' | 'blocked' | 'submitted' | 'confirmed' | 'failed' | 'review';
interface SignedDeposit { raw: string; hash: string; amount: string; gasFee: string; deadline: string; reservation: string }
interface Job { file: RecoveryFile; status: Status; reason?: string; transaction?: SignedDeposit; networkFee?: string; receiptBlockHash?: string }
interface State { version: 1; policyHash: string; jobs: Record<string, Job> }
const completed = new Interface(['event DepositCompleted(address indexed account,uint256 amount,uint256 fee)']);
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n';
const requireThat = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

/** Single operator, one durable queue. Only Arbitrum WETH and disposable local fixtures. */
export async function openRelayWorker(inputDeployment: Deployment, inputArtifacts: RecoveryArtifacts,
  signer: Signer, inputPolicy: RelayPolicy, directory: string) {
  if (!(signer.provider instanceof JsonRpcProvider)) throw new Error('Connect the operator signer to a JSON-RPC provider.');
  const provider = signer.provider;
  const route = createRailgunAdapter(inputDeployment); const deployment = route.deployment;
  const policy = Object.freeze({...inputPolicy, feeRecipient: getAddress(inputPolicy.feeRecipient)});
  const artifacts = structuredClone(inputArtifacts);
  const owner = getAddress(await signer.getAddress());
  requireThat(deployment.chainId === 31337n || deployment.chainId === 42161n
    && getAddress(deployment.asset) === '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'Automatic pricing supports Arbitrum WETH only.');
  requireThat(policy.minAmount > 0n && policy.maxAmount >= policy.minAmount && policy.maxAmount < 1n << 120n
    && policy.maxNativeFee > 0n && policy.maxTotalNativeSpend >= policy.maxNativeFee
    && Number.isInteger(policy.confirmations) && policy.confirmations >= 1 && policy.confirmations <= 64
    && Number.isInteger(policy.maxJobs) && policy.maxJobs > 0 && policy.maxJobs <= 100, 'Invalid relay spending policy.');
  const feeRecipient = getAddress(policy.feeRecipient);
  await verifyDeployment(provider, route.deployment, artifacts);
  const token = new Contract(deployment.asset, ['function decimals() view returns(uint8)'], provider);
  requireThat(await token.getFunction('decimals')() === 18n, 'Gas reimbursement requires an 18-decimal wrapped native asset.');
  const policyHash = keccak256(toUtf8Bytes(json({deployment: route.deployment, artifacts, owner, policy})));
  const dir = resolve(directory); let created = false;
  try { await mkdir(dir, {mode: 0o700}); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(dir);
  requireThat(stat.isDirectory() && (stat.mode & 0o077) === 0, 'Use a private queue directory (mode 0700).');
  const lock = join(dir, 'operator.lock');
  await mkdir(lock, {mode: 0o700}); // A stale lock requires an operator to verify the old process has stopped.
  await writeFile(join(lock, 'owner.json'), json({pid: process.pid, startedAt: new Date().toISOString()}), {mode: 0o600});
  const path = join(dir, 'queue.json');
  let state: State;
  async function save() {
    const file = await open(path + '.tmp', 'w', 0o600);
    try { await file.writeFile(json(state)); await file.sync(); } finally { await file.close(); }
    await rename(path + '.tmp', path);
    const parent = await open(dir, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  }
  try {
    if (created) { state = {version: 1, policyHash, jobs: {}}; await save(); }
    else {
      const saved = await lstat(path);
      requireThat(saved.isFile() && (saved.mode & 0o077) === 0 && saved.size <= 4_000_000, 'Invalid private queue file.');
      state = JSON.parse(await readFile(path, 'utf8')) as State;
      requireThat(state.version === 1 && state.policyHash === policyHash && state.jobs && !Array.isArray(state.jobs)
        && Object.keys(state.jobs).length <= policy.maxJobs, 'Queue policy changed or queue is invalid.');
      for (const [address, job] of Object.entries(state.jobs)) {
        requireThat(parseRecoveryFile(json(job.file)).depositAddress === address
          && ['waiting', 'blocked', 'submitted', 'confirmed', 'failed', 'review'].includes(job.status), 'Invalid saved relay job.');
        if (job.transaction) checkedTransaction(job);
        else requireThat(['waiting', 'blocked'].includes(job.status), 'Missing signed transaction.');
      }
      requireThat(reserved() <= policy.maxTotalNativeSpend, 'Saved reservations exceed the spending budget.');
    }
  } catch (error) { await rm(lock, {recursive: true}); throw error; }
  let closed = false;
  let tail = Promise.resolve();
  function serial<T>(action: () => Promise<T>) {
    const result = tail.then(async () => { requireThat(!closed, 'Worker is closed.'); return action(); });
    tail = result.then(() => {}, () => {}); return result;
  }
  function reserved() { return Object.values(state.jobs).reduce((sum, job) => sum + BigInt(job.transaction?.reservation ?? 0), 0n); }
  function execution(job: Job): DepositExecution {
    const tx = job.transaction!;
    return {...recoveryRecord(job.file), quote: {token: deployment.asset, amount: BigInt(tx.amount),
      gasFee: BigInt(tx.gasFee), deadline: BigInt(tx.deadline)}};
  }
  function request(deposit: DepositExecution) {
    return {from: owner, chainId: deployment.chainId, to: deployment.executor, value: 0n,
      data: executorABI.encodeFunctionData('deployAndExecute', [initialData(deposit, deposit.config), deposit.salt,
        deposit.config.recipient, deposit.quote])};
  }
  function checkedTransaction(job: Job) {
    const saved = job.transaction!; const deposit = execution(job); const expected = request(deposit);
    const tx = Transaction.from(saved.raw);
    requireThat(tx.hash === saved.hash && tx.from === owner && tx.to === expected.to && tx.data === expected.data
      && tx.chainId === deployment.chainId && tx.value === 0n && tx.maxPriorityFeePerGas === 0n
      && tx.gasLimit > 21000n && tx.maxFeePerGas !== null && tx.maxFeePerGas > 0n
      && tx.gasLimit * tx.maxFeePerGas === BigInt(saved.reservation)
      && BigInt(saved.reservation) <= policy.maxNativeFee
      && deposit.quote.amount >= policy.minAmount && deposit.quote.amount <= policy.maxAmount
      && deposit.quote.gasFee >= 0n && deposit.quote.gasFee <= deployment.maxGasFee
      && deposit.quote.gasFee + deposit.quote.amount / 1000n < deposit.quote.amount
      && deposit.config.relayer === owner && deposit.config.feeRecipient === feeRecipient, 'Signed deposit does not match its authorized job.');
    return tx;
  }
  async function submitted(job: Job) {
    const tx = checkedTransaction(job); const saved = job.transaction!;
    const receipt = await provider.getTransactionReceipt(saved.hash);
    if (receipt) {
      if (await provider.getBlockNumber() < receipt.blockNumber + policy.confirmations - 1) return;
      requireThat(receipt.hash === saved.hash && receipt.from === owner && receipt.to === deployment.executor
        && receipt.gasUsed <= tx.gasLimit && receipt.gasPrice <= tx.maxFeePerGas!, 'Unexpected relay receipt.');
      job.networkFee = String(receipt.gasUsed * receipt.gasPrice);
      job.receiptBlockHash = receipt.blockHash;
      if (receipt.status !== 1) { job.status = 'failed'; job.reason = 'Transaction reverted. Review before retrying.'; }
      else {
        const event = receipt.logs.filter(log => getAddress(log.address) === deployment.executor)
          .map(log => { try { return completed.parseLog(log); } catch { return null; } })
          .find(event => event?.name === 'DepositCompleted');
        requireThat(event?.args.account === job.file.depositAddress && event.args.amount === BigInt(saved.amount)
          && event.args.fee === BigInt(saved.amount) / 1000n + BigInt(saved.gasFee), 'Missing exact settlement event.');
        job.status = 'confirmed'; delete job.reason;
      }
      await save(); return;
    }
    if (await provider.getTransaction(saved.hash)) return;
    const latest = await provider.getTransactionCount(owner, 'latest');
    const pending = await provider.getTransactionCount(owner, 'pending');
    if (latest !== tx.nonce || pending !== tx.nonce) {
      job.status = 'review'; job.reason = 'Wallet nonce changed. Reconcile the saved hash before continuing.'; await save(); return;
    }
    const block = await provider.getBlock('latest');
    if (!block || BigInt(block.timestamp) > BigInt(saved.deadline)) {
      job.status = 'review'; job.reason = 'Signed quote expired. Reconcile before replacing it.'; await save(); return;
    }
    await verifyDeployment(provider, route.deployment, artifacts);
    await provider.broadcastTransaction(saved.raw); // Reuse the exact hash after an uncertain broadcast.
  }
  async function tick() {
    requireThat(BigInt(await provider.send('eth_chainId', [])) === deployment.chainId, 'Wrong operator chain.');
    for (const job of Object.values(state.jobs)) if (job.status === 'confirmed') {
      const receipt = await provider.getTransactionReceipt(job.transaction!.hash);
      if (!receipt || receipt.blockHash !== job.receiptBlockHash) {
        job.status = 'submitted'; await save(); return; // Reconcile the original hash after a chain reorganization.
      }
    }
    const outstanding = Object.values(state.jobs).filter(job => ['submitted', 'review'].includes(job.status));
    requireThat(outstanding.length <= 1, 'More than one outstanding operator transaction.');
    if (outstanding.length) { if (outstanding[0].status === 'submitted') await submitted(outstanding[0]); return; }
    await verifyDeployment(provider, route.deployment, artifacts);
    for (const job of Object.values(state.jobs)) {
      if (!['waiting', 'blocked'].includes(job.status)) continue;
      const record = recoveryRecord(job.file);
      const block = await provider.getBlock('latest'); requireThat(block, 'No current block.');
      const deadline = BigInt(block!.timestamp + 600);
      let deposit = {...record, quote: {token: deployment.asset, amount: policy.minAmount, gasFee: 0n, deadline}};
      const current = await inspectDeposit(route, deposit, provider);
      if (current.spent) { job.status = 'blocked'; job.reason = 'Account settled outside this queue; use owner recovery for any remainder.'; await save(); continue; }
      if (current.balance < policy.minAmount) { job.status = 'waiting'; delete job.reason; await save(); continue; }
      job.status = 'blocked';
      if (current.balance > policy.maxAmount) { job.reason = 'Amount exceeds operator policy. Use owner recovery.'; await save(); continue; }
      deposit.quote.amount = current.balance;
      const fee = await provider.getFeeData(); requireThat(fee.gasPrice && fee.gasPrice > 0n, 'No current gas price.');
      const gasPrice = fee.gasPrice!; const maxFeePerGas = gasPrice * 2n;
      let gasLimit = 0n; let priced = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await validateQuote(provider, route.deployment, deposit.quote);
        const estimate = await provider.estimateGas(request(deposit));
        gasLimit = (estimate * 125n + 99n) / 100n + 20000n;
        // WETH base units equal native wei. RPC estimation includes Arbitrum's data fee.
        const estimatedCost = gasLimit * gasPrice;
        if (estimatedCost <= deposit.quote.gasFee) { priced = true; break; }
        // A fee change slightly changes calldata/data gas. Leave room to converge.
        const reimbursement = (estimatedCost * 105n + 99n) / 100n;
        if (reimbursement > deployment.maxGasFee || reimbursement + current.balance / 1000n >= current.balance) break;
        deposit.quote.gasFee = reimbursement;
      }
      const reservation = gasLimit * maxFeePerGas;
      if (!priced || reservation > policy.maxNativeFee || reserved() + reservation > policy.maxTotalNativeSpend) {
        job.reason = 'Gas or total spending cap reached. Waiting; owner recovery remains available.'; await save(); continue;
      }
      if (await provider.getBalance(owner) < reservation) { job.reason = 'Operator needs gas funds.'; await save(); continue; }
      requireThat(await provider.getCode(owner) === '0x', 'This worker requires an ordinary operator wallet.');
      const nonce = await provider.getTransactionCount(owner, 'latest');
      requireThat(await provider.getTransactionCount(owner, 'pending') === nonce, 'Operator has an unrelated pending transaction.');
      const raw = await signer.signTransaction({...request(deposit), nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n, type: 2});
      job.transaction = {raw, hash: keccak256(raw), amount: String(deposit.quote.amount), gasFee: String(deposit.quote.gasFee),
        deadline: String(deadline), reservation: String(reservation)};
      job.status = 'submitted'; delete job.reason; checkedTransaction(job);
      await save(); // Signed bytes, hash, nonce and full reservation reach disk before the first broadcast.
      await submitted(job); return;
    }
  }
  return {
    configuration: Object.freeze({deployment, owner, policy}),
    register: (input: RecoveryFile) => serial(async () => {
      const file = parseRecoveryFile(json(input)); const record = recoveryRecord(file);
      requireThat(record.config.relayer === owner && record.config.feeRecipient === feeRecipient, 'Wrong operator or fee recipient.');
      await route.quote(provider, record, {token: deployment.asset, amount: policy.minAmount, gasFee: 0n, deadline: (1n << 48n) - 1n});
      if (!Object.hasOwn(state.jobs, record.address)) {
        requireThat(Object.keys(state.jobs).length < policy.maxJobs, 'Relay queue is full.');
        state.jobs[record.address] = {file, status: 'waiting'}; await save();
      }
      return record.address;
    }),
    status: (address: string) => serial(async () => {
      const job = state.jobs[getAddress(address)];
      return job ? {status: job.status, reason: job.reason, hash: job.transaction?.hash,
        amount: job.transaction?.amount, gasFee: job.transaction?.gasFee} : null;
    }),
    tick: () => serial(tick),
    run: async (signal: AbortSignal, intervalMs = 5000) => {
      requireThat(intervalMs >= 100, 'Polling interval is too short.');
      while (!signal.aborted) { await serial(tick); await delay(intervalMs, undefined, {signal}).catch(error => { if (!signal.aborted) throw error; }); }
    },
    close: () => {
      const result = tail.then(async () => { if (!closed) { closed = true; await rm(lock, {recursive: true}); } });
      tail = result.then(() => {}, () => {}); return result;
    },
  };
}
export type RelayWorker = Awaited<ReturnType<typeof openRelayWorker>>;
