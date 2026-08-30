/**
 * Establish the local credential boundary before provider SDKs initialize.
 *
 * The shipped binary disables Bun's ambient `.env` loader. Keep repository
 * dotenv values out of the host process as well: project-owned credentials
 * belong inside the confined workload, while OpenScience reads provider keys
 * from the user's shell or its owner-only local credential store.
 *
 * Older releases replayed dashboard-synced environment snapshots here. The
 * local-only runtime intentionally ignores those files.
 */
import { scrubAmbientProjectDotenv } from "./dotenv"

scrubAmbientProjectDotenv(process.cwd(), process.env)
