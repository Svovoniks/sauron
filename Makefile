run:
	bun run tauri dev

check:
	bun run check
	bun test
	cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
