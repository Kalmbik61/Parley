// `@parley/remote-client`: ядро клиента без UI (спека §10). Hermes, браузер, Node.
export * from './platform.js';
export * from './host-store.js';
export * from './relay-client.js';
export * from './rpc.js';
export * from './pair.js';
export * from './supervisor.js';
export * from './state.js';
export * from './reducer.js';
export * from './store.js';
export * from './inbox.js';
export * from './works-view.js';
// `Rpc` из actions — интерфейс вызова для действий; класс `Rpc` супервизора — из rpc.js.
export {
  readCards,
  decide,
  resolveProposal,
  type Rpc as ActionRpc,
  type ReadCardsResult,
  type DecideOutcome,
  type ResolveProposalParams,
  type ResolveOutcome,
} from './actions.js';
export * from './refresh.js';
export * from './client.js';
