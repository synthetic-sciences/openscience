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

test("the message names the tool and the reason, not just a denial", () => {
  const message = Refuse.installer(["pip", "install", "numpy"])!
  expect(message).toContain("package_install")
  expect(message).toContain("numpy")
})
