import type { Provider } from 'ethers';
import { prepareRailgunRecipient } from './recipient.ts';
import { createRecord, validateDeposit, validateQuote, verifyDeployment } from './kernel.ts';
import type { Deployment, DepositExecution, DepositRecord, DepositTerms, DepositQuote, RecoveryArtifacts } from './kernel.ts';
import { createRecoveryFile, inspectRecovery } from './recovery.ts';

export interface RailgunInput extends DepositTerms { recipient: string }
export function createRailgunAdapter(configuration: Deployment) {
  const deployment = Object.freeze({ ...configuration, codeHashes: Object.freeze({ ...configuration.codeHashes }),
    poolImplementation: configuration.poolImplementation ? Object.freeze({ ...configuration.poolImplementation }) : null,
    assetImplementation: configuration.assetImplementation ? Object.freeze({ ...configuration.assetImplementation }) : null });
  const adapter = {
    deployment,
    async prepare(provider: Provider, input: RailgunInput): Promise<DepositRecord> {
      await verifyDeployment(provider, deployment);
      return createRecord(deployment, { recipient: await prepareRailgunRecipient(input.recipient, deployment.chainId),
        recovery: input.recovery, relayer: input.relayer, feeRecipient: input.feeRecipient });
    },
    async quote(provider: Provider, record: DepositRecord, quote: DepositQuote): Promise<DepositExecution> {
      await validateDeposit(adapter, record, provider);
      await validateQuote(provider, deployment, quote);
      return { ...record, config: { ...record.config }, quote: { ...quote } };
    },
  };
  return adapter;
}

/** Trusted local recipient preparation and exact Kernel/module build checks before funding. */
export async function prepareRailgunReceive(provider: Provider, deployment: Deployment,
  input: RailgunInput, quote: DepositQuote, artifacts: RecoveryArtifacts) {
  const adapter = createRailgunAdapter(deployment);
  const record = await adapter.prepare(provider, input);
  await verifyDeployment(provider, deployment, artifacts);
  const recovery = createRecoveryFile(record);
  await inspectRecovery(provider, recovery, artifacts);
  const deposit = await adapter.quote(provider, record, quote);
  return { deposit, recovery };
}
