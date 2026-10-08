//! Local model runtime: port of the web's in-app Qwen 3.8 27B sidecar (src/lib/local-engine.ts, local-engine-shared.ts,
//! local-context.ts and the /api/local route). Each file's header lists what it leaves out.

pub mod context;
pub mod engine;
pub mod shared;
