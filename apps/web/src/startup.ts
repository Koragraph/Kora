import { showBootError } from "./util/bootError";
import { runStorageMigrations } from "./storageMigrations";

// Rewrite persisted documents to current key names before any store reads them.
runStorageMigrations();

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
