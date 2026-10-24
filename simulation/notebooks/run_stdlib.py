"""Execute every notebook with the standard library (no Jupyter needed): code cells run with exec(), stdout
becomes text output, svg("...") cells become image/svg+xml outputs. Writes the executed notebook in place."""
import contextlib, io, json, pathlib, sys, traceback

HERE = pathlib.Path(__file__).parent
PLOTS = HERE.parent / "out" / "plots"


def run(path):
    nb = json.loads(path.read_text())
    ns = {"__name__": "__nb__"}
    # make svg() emit an SVG output instead of trying IPython
    svg_outputs = []

    def svg(name):
        svg_outputs.append((PLOTS / name).read_text())

    failures = 0
    count = 0
    for cell in nb["cells"]:
        if cell["cell_type"] != "code":
            continue
        count += 1
        src = cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
        svg_outputs.clear()
        buf = io.StringIO()
        outputs = []
        with contextlib.redirect_stdout(buf):
            try:
                exec(compile(src, str(path), "exec"), ns)
                ns["svg"] = svg  # override the prelude's version once defined
            except Exception:
                failures += 1
                outputs.append({"output_type": "error", "ename": "Error", "evalue": "", "traceback": traceback.format_exc().splitlines()})
        text = buf.getvalue()
        if text:
            outputs.append({"output_type": "stream", "name": "stdout", "text": text})
        for s in svg_outputs:
            outputs.append({"output_type": "display_data", "data": {"image/svg+xml": s, "text/plain": "<chart>"}, "metadata": {}})
        cell["outputs"] = outputs
        cell["execution_count"] = count
    path.write_text(json.dumps(nb, indent=1))
    return count, failures


total_fail = 0
for p in sorted(HERE.glob("*.ipynb")):
    n, f = run(p)
    total_fail += f
    print(f"{p.name}: {n} code cells, {f} failed")
sys.exit(1 if total_fail else 0)
