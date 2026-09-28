import { startSyncWorker } from './server/sync/worker'

startSyncWorker()

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
