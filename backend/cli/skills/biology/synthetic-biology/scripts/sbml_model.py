#!/usr/bin/env python3
"""
SBML Model Builder

Programmatically create SBML Level 3 Version 2 models using python-libsbml.
Define compartments, species, reactions with kinetic laws, and parameters
via command-line JSON arguments. Validates the model for consistency and
writes a standards-compliant SBML XML file.

Usage:
    python sbml_model.py \\
      --species '[{"id": "A", "initial": 1.0}]' \\
      --reactions '[{"id": "r1", "reactants": {"A": 1}, "products": {"B": 1}, "rate_law": "k1*A", "parameters": {"k1": 0.1}}]' \\
      --output model.xml

Examples:
    # Simple A -> B conversion
    python sbml_model.py \\
      --species '[{"id":"A","initial":10.0},{"id":"B","initial":0.0}]' \\
      --reactions '[{"id":"r1","reactants":{"A":1},"products":{"B":1},"rate_law":"k1*A","parameters":{"k1":0.5}}]' \\
      --output simple_model.xml

    # Enzymatic reaction with custom compartment
    python sbml_model.py \\
      --compartments '[{"id":"cytoplasm","size":1e-15}]' \\
      --species '[{"id":"S","initial":100.0,"compartment":"cytoplasm"},{"id":"P","initial":0.0,"compartment":"cytoplasm"}]' \\
      --reactions '[{"id":"v1","reactants":{"S":1},"products":{"P":1},"rate_law":"Vmax*S/(Km+S)","parameters":{"Vmax":10.0,"Km":5.0}}]' \\
      --output enzyme.xml

    # Reversible reaction
    python sbml_model.py \\
      --species '[{"id":"X","initial":5.0},{"id":"Y","initial":0.0}]' \\
      --reactions '[{"id":"r1","reactants":{"X":1},"products":{"Y":1},"rate_law":"kf*X - kr*Y","parameters":{"kf":1.0,"kr":0.5},"reversible":true}]' \\
      --output reversible.xml

Dependencies: python-libsbml
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import libsbml
except ImportError:
    print(
        "ERROR: python-libsbml is required. Install with: pip install python-libsbml",
        file=sys.stderr,
    )
    sys.exit(1)


def check_libsbml(value, message):
    """Check libsbml return value and raise on error."""
    if value is None:
        raise RuntimeError(f"LibSBML returned None: {message}")
    if isinstance(value, int):
        if value == libsbml.LIBSBML_OPERATION_SUCCESS:
            return
        raise RuntimeError(
            f"LibSBML error ({value}): {message} - "
            f"{libsbml.OperationReturnValue_toString(value)}"
        )


def create_sbml_document():
    """Create a new SBML Level 3 Version 2 document with a model."""
    try:
        document = libsbml.SBMLDocument(3, 2)
    except ValueError:
        raise RuntimeError("Could not create SBMLDocument (Level 3 Version 2)")

    model = document.createModel()
    check_libsbml(model, "create model")
    check_libsbml(model.setId("model"), "set model ID")
    check_libsbml(model.setName("Generated Model"), "set model name")

    # Set default units
    check_libsbml(model.setTimeUnits("second"), "set time units")
    check_libsbml(model.setSubstanceUnits("mole"), "set substance units")
    check_libsbml(model.setExtentUnits("mole"), "set extent units")

    # Define unit definitions
    _add_unit_definition(model, "per_second", [
        (libsbml.UNIT_KIND_SECOND, -1, 0, 1.0),
    ])

    return document, model


def _add_unit_definition(model, uid, units):
    """Add a unit definition to the model."""
    ud = model.createUnitDefinition()
    check_libsbml(ud, f"create unit definition {uid}")
    check_libsbml(ud.setId(uid), f"set unit definition id {uid}")
    for kind, exponent, scale, multiplier in units:
        u = ud.createUnit()
        check_libsbml(u, f"create unit in {uid}")
        check_libsbml(u.setKind(kind), "set unit kind")
        check_libsbml(u.setExponent(exponent), "set unit exponent")
        check_libsbml(u.setScale(scale), "set unit scale")
        check_libsbml(u.setMultiplier(multiplier), "set unit multiplier")


def add_compartments(model, compartments_data):
    """Add compartments to the model."""
    added = []
    for comp_def in compartments_data:
        comp_id = comp_def["id"]
        size = comp_def.get("size", 1.0)
        dims = comp_def.get("dimensions", 3)
        constant = comp_def.get("constant", True)
        name = comp_def.get("name", "")

        c = model.createCompartment()
        check_libsbml(c, f"create compartment {comp_id}")
        check_libsbml(c.setId(comp_id), f"set compartment id {comp_id}")
        check_libsbml(c.setConstant(constant), f"set compartment constant {comp_id}")
        check_libsbml(c.setSpatialDimensions(dims), f"set compartment dims {comp_id}")
        check_libsbml(c.setSize(size), f"set compartment size {comp_id}")
        check_libsbml(c.setUnits("litre"), f"set compartment units {comp_id}")
        if name:
            check_libsbml(c.setName(name), f"set compartment name {comp_id}")

        added.append(comp_id)

    return added


def add_species(model, species_data, default_compartment="cell"):
    """Add species to the model."""
    added = []
    for sp_def in species_data:
        sp_id = sp_def["id"]
        initial = sp_def.get("initial", 0.0)
        compartment = sp_def.get("compartment", default_compartment)
        boundary = sp_def.get("boundary_condition", False)
        constant = sp_def.get("constant", False)
        has_only_substance = sp_def.get("has_only_substance_units", False)
        name = sp_def.get("name", "")

        s = model.createSpecies()
        check_libsbml(s, f"create species {sp_id}")
        check_libsbml(s.setId(sp_id), f"set species id {sp_id}")
        check_libsbml(s.setCompartment(compartment), f"set species compartment {sp_id}")
        check_libsbml(s.setInitialConcentration(initial), f"set species initial {sp_id}")
        check_libsbml(s.setBoundaryCondition(boundary), f"set species boundary {sp_id}")
        check_libsbml(s.setConstant(constant), f"set species constant {sp_id}")
        check_libsbml(
            s.setHasOnlySubstanceUnits(has_only_substance),
            f"set species hasOnlySubstanceUnits {sp_id}",
        )
        if name:
            check_libsbml(s.setName(name), f"set species name {sp_id}")

        added.append(sp_id)

    return added


def add_reactions(model, reactions_data):
    """Add reactions with kinetic laws to the model."""
    added = []
    for rxn_def in reactions_data:
        rxn_id = rxn_def["id"]
        reactants = rxn_def.get("reactants", {})
        products = rxn_def.get("products", {})
        rate_law = rxn_def.get("rate_law", "")
        parameters = rxn_def.get("parameters", {})
        reversible = rxn_def.get("reversible", False)
        name = rxn_def.get("name", "")
        modifiers = rxn_def.get("modifiers", [])

        r = model.createReaction()
        check_libsbml(r, f"create reaction {rxn_id}")
        check_libsbml(r.setId(rxn_id), f"set reaction id {rxn_id}")
        check_libsbml(r.setReversible(reversible), f"set reaction reversible {rxn_id}")
        check_libsbml(r.setFast(False), f"set reaction fast {rxn_id}")
        if name:
            check_libsbml(r.setName(name), f"set reaction name {rxn_id}")

        # Add reactants
        for species_id, stoich in reactants.items():
            sr = r.createReactant()
            check_libsbml(sr, f"create reactant {species_id} in {rxn_id}")
            check_libsbml(sr.setSpecies(species_id), f"set reactant species {species_id}")
            check_libsbml(sr.setStoichiometry(float(stoich)), f"set reactant stoich {species_id}")
            check_libsbml(sr.setConstant(True), f"set reactant constant {species_id}")

        # Add products
        for species_id, stoich in products.items():
            sp = r.createProduct()
            check_libsbml(sp, f"create product {species_id} in {rxn_id}")
            check_libsbml(sp.setSpecies(species_id), f"set product species {species_id}")
            check_libsbml(sp.setStoichiometry(float(stoich)), f"set product stoich {species_id}")
            check_libsbml(sp.setConstant(True), f"set product constant {species_id}")

        # Add modifiers
        for mod_id in modifiers:
            sm = r.createModifier()
            check_libsbml(sm, f"create modifier {mod_id} in {rxn_id}")
            check_libsbml(sm.setSpecies(mod_id), f"set modifier species {mod_id}")

        # Add kinetic law
        if rate_law:
            kl = r.createKineticLaw()
            check_libsbml(kl, f"create kinetic law for {rxn_id}")

            # Parse the rate law formula into MathML AST
            ast = libsbml.parseL3Formula(rate_law)
            if ast is None:
                raise ValueError(
                    f"Could not parse rate law '{rate_law}' for reaction {rxn_id}: "
                    f"{libsbml.getLastParseL3Error()}"
                )
            check_libsbml(kl.setMath(ast), f"set kinetic law math for {rxn_id}")

            # Add local parameters
            for param_id, param_val in parameters.items():
                lp = kl.createLocalParameter()
                check_libsbml(lp, f"create local parameter {param_id} in {rxn_id}")
                check_libsbml(lp.setId(param_id), f"set parameter id {param_id}")
                check_libsbml(lp.setValue(float(param_val)), f"set parameter value {param_id}")
                check_libsbml(lp.setConstant(True), f"set parameter constant {param_id}")

        added.append(rxn_id)

    return added


def validate_model(document):
    """Validate the SBML model and return any errors/warnings."""
    document.checkConsistency()
    errors = []
    warnings = []

    for i in range(document.getNumErrors()):
        err = document.getError(i)
        severity = err.getSeverity()
        msg = f"[{err.getSeverityAsString()}] Line {err.getLine()}: {err.getMessage()}"

        if severity >= libsbml.LIBSBML_SEV_ERROR:
            errors.append(msg)
        elif severity >= libsbml.LIBSBML_SEV_WARNING:
            warnings.append(msg)

    return errors, warnings


def write_sbml(document, filepath):
    """Write the SBML document to an XML file."""
    writer = libsbml.SBMLWriter()
    success = writer.writeSBMLToFile(document, str(filepath))
    if not success:
        raise RuntimeError(f"Failed to write SBML file: {filepath}")


def print_model_summary(model):
    """Print a human-readable summary of the SBML model."""
    print(f"=== SBML Model Summary ===")
    print(f"Model ID:      {model.getId()}")
    print(f"SBML Level:    {model.getLevel()}")
    print(f"SBML Version:  {model.getVersion()}")
    print()

    # Compartments
    n_comp = model.getNumCompartments()
    print(f"Compartments ({n_comp}):")
    for i in range(n_comp):
        c = model.getCompartment(i)
        print(f"  {c.getId()}: size = {c.getSize()}, dims = {c.getSpatialDimensions()}")
    print()

    # Species
    n_sp = model.getNumSpecies()
    print(f"Species ({n_sp}):")
    for i in range(n_sp):
        s = model.getSpecies(i)
        print(f"  {s.getId()}: initial = {s.getInitialConcentration():.4g}, "
              f"compartment = {s.getCompartment()}")
    print()

    # Reactions
    n_rxn = model.getNumReactions()
    print(f"Reactions ({n_rxn}):")
    for i in range(n_rxn):
        r = model.getReaction(i)

        # Build reaction equation
        reactant_strs = []
        for j in range(r.getNumReactants()):
            sr = r.getReactant(j)
            stoich = sr.getStoichiometry()
            sid = sr.getSpecies()
            if stoich == 1.0:
                reactant_strs.append(sid)
            else:
                reactant_strs.append(f"{stoich:.0f} {sid}")

        product_strs = []
        for j in range(r.getNumProducts()):
            sp = r.getProduct(j)
            stoich = sp.getStoichiometry()
            sid = sp.getSpecies()
            if stoich == 1.0:
                product_strs.append(sid)
            else:
                product_strs.append(f"{stoich:.0f} {sid}")

        arrow = " <-> " if r.getReversible() else " -> "
        equation = " + ".join(reactant_strs) + arrow + " + ".join(product_strs)

        # Rate law
        kl = r.getKineticLaw()
        rate_str = ""
        if kl and kl.getMath():
            rate_str = libsbml.formulaToInfix(kl.getMath())

        print(f"  {r.getId()}: {equation}")
        if rate_str:
            print(f"    Rate law: {rate_str}")

        # Local parameters
        if kl:
            n_params = kl.getNumLocalParameters()
            if n_params > 0:
                param_strs = []
                for j in range(n_params):
                    lp = kl.getLocalParameter(j)
                    param_strs.append(f"{lp.getId()} = {lp.getValue():.4g}")
                print(f"    Parameters: {', '.join(param_strs)}")

    print()

    # Global parameters
    n_params = model.getNumParameters()
    if n_params > 0:
        print(f"Global Parameters ({n_params}):")
        for i in range(n_params):
            p = model.getParameter(i)
            print(f"  {p.getId()} = {p.getValue():.4g}")
        print()


def main():
    parser = argparse.ArgumentParser(
        description="Create SBML Level 3 models programmatically",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Species JSON format:
  [{"id": "A", "initial": 1.0, "compartment": "cell"}, ...]

Reactions JSON format:
  [{"id": "r1", "reactants": {"A": 1}, "products": {"B": 1},
    "rate_law": "k1*A", "parameters": {"k1": 0.1}}, ...]

Compartments JSON format:
  [{"id": "cell", "size": 1.0}]

Examples:
  %(prog)s --species '[{"id":"A","initial":10}]' \\
    --reactions '[{"id":"r1","reactants":{"A":1},"products":{"B":1},"rate_law":"k*A","parameters":{"k":0.1}}]' \\
    --output model.xml
        """,
    )
    parser.add_argument(
        "--species", required=True,
        help="JSON array of species definitions",
    )
    parser.add_argument(
        "--reactions", required=True,
        help="JSON array of reaction definitions",
    )
    parser.add_argument(
        "--compartments", default=None,
        help='JSON array of compartment definitions (default: [{"id":"cell","size":1.0}])',
    )
    parser.add_argument(
        "--output", required=True,
        help="Output SBML XML file path",
    )
    args = parser.parse_args()

    # Parse JSON inputs
    try:
        species_data = json.loads(args.species)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON for --species: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        reactions_data = json.loads(args.reactions)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON for --reactions: {e}", file=sys.stderr)
        sys.exit(1)

    if args.compartments:
        try:
            compartments_data = json.loads(args.compartments)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON for --compartments: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        compartments_data = [{"id": "cell", "size": 1.0}]

    # Validate inputs
    if not species_data:
        print("ERROR: At least one species is required", file=sys.stderr)
        sys.exit(1)

    if not reactions_data:
        print("ERROR: At least one reaction is required", file=sys.stderr)
        sys.exit(1)

    for sp in species_data:
        if "id" not in sp:
            print("ERROR: Each species must have an 'id' field", file=sys.stderr)
            sys.exit(1)

    for rxn in reactions_data:
        if "id" not in rxn:
            print("ERROR: Each reaction must have an 'id' field", file=sys.stderr)
            sys.exit(1)
        if "rate_law" not in rxn:
            print(f"ERROR: Reaction '{rxn['id']}' is missing 'rate_law'", file=sys.stderr)
            sys.exit(1)

    # Build model
    print("Building SBML model...")
    try:
        document, model = create_sbml_document()

        # Add compartments
        comp_ids = add_compartments(model, compartments_data)
        default_compartment = comp_ids[0] if comp_ids else "cell"

        # Add species
        sp_ids = add_species(model, species_data, default_compartment)

        # Add reactions
        rxn_ids = add_reactions(model, reactions_data)

    except (RuntimeError, ValueError) as e:
        print(f"ERROR: Model construction failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Validate
    errors, warnings = validate_model(document)

    if warnings:
        print(f"\nValidation warnings ({len(warnings)}):")
        for w in warnings[:10]:
            print(f"  {w}")
        if len(warnings) > 10:
            print(f"  ... and {len(warnings) - 10} more")

    if errors:
        print(f"\nValidation errors ({len(errors)}):")
        for e in errors[:10]:
            print(f"  {e}")
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more")
        print("\nWARNING: Model has validation errors but will still be saved.")

    if not errors and not warnings:
        print("Validation: PASSED (no errors or warnings)")

    print()

    # Print summary
    print_model_summary(model)

    # Write output
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        write_sbml(document, str(out_path))
        print(f"SBML file saved: {out_path}")
        print(f"File size: {out_path.stat().st_size} bytes")
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
