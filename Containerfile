# syntax=docker/dockerfile:1.7
#
# Build a fully static crypt-chat binary, with the React/Vite frontend
# embedded via rust-embed, and ship it inside distroless/static.
#
# - Stage 1 (node) builds the frontend → frontend/dist
# - Stage 2 (rust) builds the Rust binary against musl, with the dist
#   from stage 1 dropped in so build.rs can skip pnpm
# - Stage 3 (runtime) is a ~2 MB distroless image running as nonroot
#
# Image: ghcr.io/<owner>/crypt-chat:latest

# ---- Stage 1: frontend ----------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend

# Use pnpm via corepack so we don't depend on a system pnpm.
RUN corepack enable

# Cache deps separately from sources for faster rebuilds.
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm build


# ---- Stage 2: rust --------------------------------------------------------
FROM rust:1.85-alpine AS rust
WORKDIR /app

# musl-tools so we get a fully static binary without glibc dependencies.
RUN apk add --no-cache musl-dev

# We pre-build the frontend in stage 1; tell build.rs not to invoke pnpm.
ENV SKIP_FRONTEND_BUILD=1

# Cache cargo deps. We copy only Cargo.{toml,lock} + a stub main.rs first,
# build, then bring in the real sources. This keeps the deps layer hot
# across most code edits.
COPY Cargo.toml Cargo.lock build.rs ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
# Need at least an index.html so rust-embed's macro doesn't fail at build.
RUN mkdir -p frontend/dist && echo "<!doctype html>" > frontend/dist/index.html
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cargo-target,target=/app/target,sharing=locked \
    cargo build --release --target $(uname -m)-unknown-linux-musl

# Now bring in the real sources + the prebuilt frontend dist.
COPY src ./src
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Touch main.rs so cargo rebuilds the binary, not just deps.
RUN touch src/main.rs
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cargo-target,target=/app/target,sharing=locked \
    cargo build --release --target $(uname -m)-unknown-linux-musl && \
    cp target/$(uname -m)-unknown-linux-musl/release/crypt-chat /app/crypt-chat


# ---- Stage 3: runtime -----------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=rust /app/crypt-chat /usr/local/bin/crypt-chat

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/crypt-chat"]
CMD ["--addr", "0.0.0.0", "--port", "8080"]
