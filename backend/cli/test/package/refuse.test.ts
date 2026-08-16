import { expect, test } from "bun:test"
import { Refuse } from "../../src/package/refuse"

test.each([
  ["pip install numpy"],
  ["pip3 install numpy"],
  ["pip install -r requirements.txt"],
  ["uv pip install numpy"],
  ["conda install numpy"],
  ["mamba install numpy"],
  ["poetry add numpy"],
  // The venv-in-workspace route, which is what actually works today and what
  // a bare "pip install" match misses entirely.
  ["/work/project/venv/bin/pip install numpy"],
  ["./venv/bin/pip install numpy"],
  ["python -m pip install numpy"],
  ["python3 -m pip install numpy"],
  ["/usr/bin/python3.14 -m pip install numpy"],
  ["./venv/bin/python -m pip install numpy"],
])("refuses %s", (line) => {
  const message = Refuse.installer(line.split(" "))
  expect(message).toBeString()
  expect(message).toContain("package_install")
})

test.each([
  // Read-only inspection stays allowed: refusing these would break ordinary
  // work and teach the agent that the whole tool is unreliable.
  ["pip list"],
  ["pip show numpy"],
  ["pip --version"],
  ["python -m pip list"],
  ["conda env list"],
  // Not installers at all.
  ["python analysis.py"],
  ["npm install"],
  ["git install-hooks"],
  ["echo pip install numpy"],
])("allows %s", (line) => {
  expect(Refuse.installer(line.split(" "))).toBeUndefined()
})

// The four entry points the matcher missed while `prompt.ts` told the agent all
// of them were refused. Each installs into an environment the tool does not own,
// with no approval card and no manifest entry.
test.each([
  // uv, beyond `uv pip`.
  ["uv add tqdm", "tqdm"],
  ["uv remove tqdm", "tqdm"],
  ["uv sync", undefined],
  // pipx: not `pip` followed by digits, so the old pattern let it through.
  ["pipx install black", "black"],
  // R — the one language this feature added installs for, and the one the
  // matcher had no branch for at all. The call sits inside a script argument
  // rather than an argv position.
  ['Rscript -e install.packages("data.table")', undefined],
  ['R -e BiocManager::install("limma")', undefined],
  ['Rscript -e remotes::install_github("r-lib/fs")', undefined],
  ["R CMD INSTALL ./pkg", "./pkg"],
])("refuses %s", (line, named) => {
  const message = Refuse.installer(line.split(" "))
  expect(message).toContain("package_install")
  if (named) expect(message).toContain(named)
})

// The negative half. A refusal that fires on read-only or unrelated work is a
// worse failure than one that misses: it blocks real work and teaches the agent
// the tool is unreliable.
test.each([
  ["uv run script.py"],
  ["uv venv"],
  ["uv lock"],
  ["uv python list"],
  ["Rscript analysis.R"],
  ["R --version"],
  ["Rscript -e library(data.table)"],
  ["R CMD build ./pkg"],
  ["pipx list"],
])("allows %s", (line) => {
  expect(Refuse.installer(line.split(" "))).toBeUndefined()
})

test("the message names the tool and the reason, not just a denial", () => {
  const message = Refuse.installer(["pip", "install", "numpy"])!
  expect(message).toContain("package_install")
  expect(message).toContain("numpy")
})
