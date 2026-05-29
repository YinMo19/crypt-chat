use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/index.html");
    println!("cargo:rerun-if-changed=frontend/package.json");
    println!("cargo:rerun-if-changed=frontend/pnpm-lock.yaml");
    println!("cargo:rerun-if-changed=frontend/vite.config.ts");
    println!("cargo:rerun-if-changed=frontend/tailwind.config.js");
    println!("cargo:rerun-if-changed=frontend/postcss.config.js");
    println!("cargo:rerun-if-changed=frontend/tsconfig.json");

    let frontend_dir = Path::new("frontend");
    if !frontend_dir.exists() {
        panic!("frontend/ directory not found");
    }

    // Skip if SKIP_FRONTEND_BUILD=1 (useful in CI matrix builds where the
    // frontend has already been built once and cached).
    if std::env::var("SKIP_FRONTEND_BUILD").is_ok() {
        println!("cargo:warning=SKIP_FRONTEND_BUILD set, skipping pnpm build");
        ensure_dist_exists(frontend_dir);
        return;
    }

    if !frontend_dir.join("node_modules").exists() {
        run("pnpm", &["install"], frontend_dir);
    }

    run("pnpm", &["build"], frontend_dir);

    ensure_dist_exists(frontend_dir);
}

fn ensure_dist_exists(frontend_dir: &Path) {
    let dist_index = frontend_dir.join("dist").join("index.html");
    if !dist_index.exists() {
        // rust-embed needs the folder to exist; write a placeholder so cargo
        // doesn't fail before pnpm build has been run at least once.
        std::fs::create_dir_all(frontend_dir.join("dist")).ok();
        std::fs::write(
            &dist_index,
            "<!doctype html><meta charset=utf-8><title>crypt-chat</title><p>frontend not built</p>",
        )
        .ok();
    }
}

fn run(cmd: &str, args: &[&str], dir: &Path) {
    let status = Command::new(cmd)
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap_or_else(|e| panic!("failed to spawn {cmd}: {e}"));
    if !status.success() {
        panic!("{cmd} {:?} exited with {status}", args);
    }
}
