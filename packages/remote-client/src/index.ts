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
export * from './capabilities.js';
// `Rpc` из actions — интерфейс вызова для действий; класс `Rpc` супервизора — из rpc.js.
export {
  readCards,
  decide,
  resolveProposal,
  createSession,
  createRoom,
  sendRoomMessage,
  loadProviders,
  loadRoles,
  type Rpc as ActionRpc,
  type Rejected,
  type CreateSessionParams,
  type CreateSessionOutcome,
  type CreateRoomParams,
  type CreateRoomOutcome,
  type SendRoomMessageParams,
  type SendRoomMessageOutcome,
  type ReadCardsResult,
  type DecideOutcome,
  type ResolveProposalParams,
  type ResolveOutcome,
} from './actions.js';
export * from './refresh.js';
export * from './client.js';
