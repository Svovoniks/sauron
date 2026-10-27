// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--mcp") {
        if let Err(e) = sauron_lib::run_mcp(args.iter().any(|a| a == "--allow-writes")) {
            eprintln!("sauron --mcp: {e}");
            std::process::exit(1);
        }
        return;
    }
    sauron_lib::run()
}
