//! Scenario runner. `cargo run --release -p confluere-sim -- all` writes every CSV into `out/`.

mod common;
mod scenarios;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let which = args.first().map(|s| s.as_str()).unwrap_or("all");
    let n: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let run = |name: &str| which == "all" || which == name;
    if run("crosscheck") {
        scenarios::crosscheck::run(if n == 0 { 60 } else { n });
    }
    if run("baseline") {
        scenarios::baseline::run(if n == 0 { 8 } else { n });
    }
    if run("fee_wash") {
        scenarios::fee_wash::run();
    }
    if run("nc_pricing") {
        scenarios::nc_pricing::run();
    }
    if run("vault_tier") {
        scenarios::vault_tier::run();
    }
    if run("graduation") {
        scenarios::graduation::run();
    }
    if run("grid") {
        scenarios::misc::grid();
    }
    if run("pause") {
        scenarios::misc::pause();
    }
    if run("revenue") {
        scenarios::misc::revenue();
    }
    if run("earn") {
        scenarios::earn::run();
    }
    if run("loop") {
        scenarios::loop_::run();
    }
    if run("flashloan") {
        scenarios::flashloan::run();
    }
    if run("rollover") {
        scenarios::rollover::run();
    }
    if run("abandonment") {
        scenarios::abandonment::run();
    }
    if run("edge") {
        scenarios::edge::run();
    }
    if run("gas") {
        scenarios::gas::run();
    }
    if run("security") {
        scenarios::security::run();
    }
    if run("seats") {
        scenarios::seats::run();
    }
    if run("chaos") {
        scenarios::chaos::run(if n == 0 { 6 } else { n });
    }
}
