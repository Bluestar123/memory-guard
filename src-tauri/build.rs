fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=tauri.release.conf.json");
    println!("cargo:rerun-if-changed=Cargo.toml");
    tauri_build::build();
}
