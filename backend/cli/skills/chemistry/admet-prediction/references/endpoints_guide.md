# ADMET Endpoints Reference Guide

A comprehensive reference explaining all ADMET endpoints predicted by this skill, their clinical significance, computational thresholds, limitations, and prioritization guidance.

---

## Table of Contents

1. [Absorption Endpoints](#absorption-endpoints)
2. [Distribution Endpoints](#distribution-endpoints)
3. [Metabolism Endpoints](#metabolism-endpoints)
4. [Excretion Endpoints](#excretion-endpoints)
5. [Toxicity Endpoints](#toxicity-endpoints)
6. [Drug-Likeness Metrics](#drug-likeness-metrics)
7. [Endpoint Prioritization by Therapeutic Area](#endpoint-prioritization-by-therapeutic-area)

---

## Absorption Endpoints

### Caco-2 Permeability (Apparent Permeability)

**What it measures:** The rate at which a compound crosses a monolayer of Caco-2 cells (human colon adenocarcinoma), which model the intestinal epithelial barrier. Reported as an apparent permeability coefficient (Papp) or classified into high/medium/low categories.

**Clinical significance:** Caco-2 permeability is the standard in vitro predictor of intestinal absorption for oral drugs. Low permeability compounds typically show poor oral bioavailability and may require formulation strategies or alternative routes of administration.

**Thresholds:**
- GREEN (High permeability): TPSA < 90 Angstroms squared. Compounds in this range typically have Papp > 8 x 10^-6 cm/s and are expected to have good intestinal absorption.
- YELLOW (Medium permeability): TPSA 90-140 Angstroms squared. Intermediate absorption; may benefit from formulation optimization.
- RED (Low permeability): TPSA > 140 Angstroms squared. Likely poor oral absorption; consider prodrug strategies or non-oral routes.

**Limitations:** The TPSA-based estimate is a surrogate. Actual Caco-2 assays also capture active transport (influx and efflux), paracellular transport, and metabolic stability within the monolayer, none of which are captured by TPSA alone.

---

### Human Intestinal Absorption (HIA)

**What it measures:** The fraction of an orally administered dose that is absorbed from the gastrointestinal tract into the portal vein. Expressed as a percentage or classified as high (>80%) or low (<20%).

**Clinical significance:** HIA is the first pharmacokinetic hurdle for oral drugs. Compounds with low HIA will have low oral bioavailability regardless of other properties.

**Thresholds:**
- GREEN (Likely high): TPSA < 140 and RotBonds <= 10. Most FDA-approved oral drugs fall in this space.
- YELLOW (Uncertain): One criterion met but not both.
- RED (Likely low): TPSA > 140 and RotBonds > 10. Compounds in this region are typically too polar and flexible for passive intestinal absorption.

**Limitations:** Active transport (e.g., amino acid transporters, PEPT1) can rescue compounds with unfavorable passive permeability properties. Formulation (e.g., amorphous solid dispersions) can also improve absorption of poorly soluble compounds.

---

### P-glycoprotein (Pgp) Substrate Likelihood

**What it measures:** Whether a compound is likely to be a substrate for P-glycoprotein (ABCB1), a major efflux transporter expressed at the intestinal lumen, blood-brain barrier, and renal tubules.

**Clinical significance:** Pgp substrates may have reduced oral bioavailability (intestinal efflux), limited brain penetration (BBB efflux), and drug-drug interaction risk with Pgp inhibitors (e.g., verapamil, cyclosporine).

**Thresholds:**
- GREEN (Unlikely substrate): MW < 400 and TPSA < 100 and no Pgp-associated structural motifs.
- YELLOW (Possible substrate): Borderline size/polarity or structural motif match.
- RED (Likely substrate): MW > 400 and TPSA > 130. Large, polar molecules are frequently Pgp substrates.

**Limitations:** Pgp substrate prediction from physicochemical properties alone has moderate accuracy. In vitro bidirectional transport assays (e.g., MDCK-MDR1) are required for definitive assessment.

---

### Aqueous Solubility (LogS, ESOL Model)

**What it measures:** The thermodynamic aqueous solubility of a compound at pH 7.4, expressed as log10 of the molar concentration (logS). Predicted using the Delaney ESOL equation: logS = 0.16 - 0.63*logP - 0.0062*MW + 0.066*RotBonds - 0.74*AromaticProportion.

**Clinical significance:** Adequate aqueous solubility is essential for oral absorption (dissolution in GI fluids), parenteral formulation, and in vitro assay reliability. The biopharmaceutics classification system (BCS) uses solubility as a primary classifier.

**Thresholds:**
- GREEN: logS > -4 (solubility > 0.1 mM). Adequate for most formulation approaches.
- YELLOW: logS -4 to -6 (solubility 0.001 to 0.1 mM). May require enabling formulations (e.g., nanoparticles, cyclodextrins, amorphous forms).
- RED: logS < -6 (solubility < 0.001 mM). Severe solubility limitation; likely requires major structural modification or specialized delivery.

**Limitations:** ESOL is a simple linear model with RMSE of approximately 0.7 log units. It does not account for crystal packing, polymorphism, salt formation, or pH effects. Experimental kinetic solubility (e.g., nephelometry) and thermodynamic solubility (shake-flask) should be measured for advanced compounds.

---

## Distribution Endpoints

### Blood-Brain Barrier (BBB) Penetration

**What it measures:** The ability of a compound to cross the blood-brain barrier and distribute into brain tissue. Assessed as a qualitative likelihood (likely/uncertain/unlikely).

**Clinical significance:** Critical for CNS drugs (must penetrate) and also for peripheral drugs (brain penetration may cause CNS side effects). The BBB is a tightly regulated endothelial barrier with limited paracellular transport.

**Thresholds:**
- GREEN (Likely penetrant): BBB score (logP - TPSA/60) > 0, MW < 450, TPSA < 90.
- YELLOW (Uncertain): BBB score > -0.5 but other criteria not fully met.
- RED (Unlikely penetrant): BBB score < -0.5 or MW > 450 or TPSA > 90.

**Limitations:** This is a simplified physicochemical estimate. Actual BBB penetration depends on Pgp efflux at the BBB, plasma protein binding (free fraction), active influx transporters, and metabolic stability. In vivo brain-to-plasma ratios (Kp,uu) are the gold standard.

---

### Plasma Protein Binding (PPB)

**What it measures:** The fraction of drug bound to plasma proteins (primarily albumin and alpha-1-acid glycoprotein). Expressed as a percentage or qualitative class.

**Clinical significance:** Only the unbound (free) fraction of drug in plasma is pharmacologically active, available for distribution, and subject to clearance. High PPB (>99%) may limit free drug exposure but also extends half-life. PPB itself is not a liability; the relevant metric is free drug concentration at the target site.

**Thresholds:**
- GREEN: PPB < 95% (LogP < 4). Adequate free fraction for most targets.
- YELLOW: PPB > 95% (LogP > 4). May limit free drug levels; important to measure free fraction and adjust dosing.
- GREEN: PPB < 50% (LogP < 0). Low binding, high free fraction.

**Limitations:** LogP alone is a crude predictor. Actual PPB depends on specific binding interactions with albumin (acidic drugs) or AAG (basic drugs), not just lipophilicity. Rapid equilibrium dialysis (RED) or ultrafiltration assays are needed for accurate measurement.

---

### Volume of Distribution (VDss)

**What it measures:** The apparent volume into which a drug distributes at steady state. High VDss indicates extensive tissue distribution; low VDss indicates confinement to plasma.

**Clinical significance:** VDss influences half-life (together with clearance), loading dose requirements, and tissue exposure. Very high VDss (>10 L/kg) may indicate tissue accumulation.

**Thresholds:**
- GREEN (Moderate): 0.5-2 L/kg. Distributes beyond plasma but not excessively.
- YELLOW (High): >2 L/kg with basic nitrogen and LogP > 3. Extensive tissue binding likely.
- GREEN (Low): <0.5 L/kg. Largely confined to plasma and extracellular fluid.

**Limitations:** VDss prediction from physicochemical properties is approximate. Actual VDss depends on tissue binding affinity, ionization state, transporter activity, and blood flow. In vivo PK studies are definitive.

---

## Metabolism Endpoints

### CYP450 Liability (CYP3A4, CYP2D6, CYP2C9)

**What it measures:** The likelihood of a compound being a substrate for or inhibitor of major cytochrome P450 enzymes. The three most clinically important isoforms are assessed: CYP3A4 (metabolizes ~50% of drugs), CYP2D6 (~25%), and CYP2C9 (~15%).

**Clinical significance:**
- **CYP substrates** are subject to drug-drug interactions (DDIs) when co-administered with CYP inhibitors or inducers.
- **CYP inhibitors** can cause DDIs by increasing exposure of co-administered CYP substrates.
- **CYP3A4** has broad substrate specificity; large lipophilic molecules are common substrates.
- **CYP2D6** preferentially metabolizes basic amines with an aromatic ring 5-7 Angstroms from the nitrogen.
- **CYP2C9** preferentially metabolizes anionic (acidic) lipophilic compounds.

**Thresholds:**
- GREEN: No structural alerts and no size/lipophilicity flags.
- YELLOW: 1 structural alert or borderline physicochemical properties.
- RED: 2+ alerts. High likelihood of CYP-mediated metabolism or inhibition.

**Limitations:** SMARTS-based alerts capture known motifs but miss many CYP substrates. Experimental CYP inhibition (IC50 panel), metabolic stability (human liver microsomes), and CYP reaction phenotyping are required for definitive assessment. The computational approach cannot distinguish substrates from inhibitors.

---

### Metabolic Soft Spots

**What it measures:** Specific molecular sites prone to Phase I metabolic oxidation, hydrolysis, or conjugation. Identified by SMARTS pattern matching against known labile functional groups.

**Clinical significance:** Soft spots determine the primary routes of metabolic clearance. Blocking or modifying soft spots (e.g., replacing a benzylic CH2 with a CF2) is a core medicinal chemistry optimization strategy to improve metabolic stability and half-life.

**Identified soft spots include:**
- Benzylic CH2 and aryl methyl (CYP-mediated oxidation)
- N-dealkylation sites (CYP2D6, CYP3A4)
- Ester and amide hydrolysis (esterases, amidases)
- S-methyl and thioether (S-oxidation)
- Phenol (UGT glucuronidation)
- Aromatic amine (NAT acetylation)

**Thresholds:**
- GREEN: 0-1 soft spots. Likely metabolically stable.
- YELLOW: 2-3 soft spots. Moderate metabolic liability.
- RED: 4+ soft spots. High metabolic turnover expected.

**Limitations:** Soft spot identification is qualitative. The actual rate of metabolism depends on the three-dimensional orientation in the CYP active site, electronic effects, and steric accessibility, none of which are captured by SMARTS matching. In vitro metabolite identification (MetID) studies with human liver microsomes or hepatocytes are the experimental standard.

---

## Excretion Endpoints

### Clearance Route and Rate

**What it measures:** The predicted primary route (hepatic vs. renal) and rate class (low/moderate/high) of elimination.

**Clinical significance:** Clearance determines half-life (together with VDss), dosing frequency, and steady-state exposure. Hepatically cleared drugs are subject to CYP-mediated DDIs and liver impairment effects. Renally cleared drugs are affected by kidney impairment.

**Thresholds:**
- GREEN (Renal): MW < 350, LogP < 1, TPSA > 80. Small polar molecules cleared by glomerular filtration.
- GREEN (Moderate hepatic): LogP 2-3. Typical for many oral drugs.
- YELLOW (Hepatic, lipophilic): LogP > 3, MW > 400. High hepatic extraction likely.
- RED (High clearance risk): LogP > 4, MW > 500. May have very high first-pass metabolism and short half-life.

**Limitations:** Clearance prediction from physicochemical properties is the least accurate of all ADMET endpoints. Actual clearance depends on enzyme kinetics (Vmax, Km), blood flow (well-stirred model), transporter-mediated uptake into hepatocytes (OATP1B1/1B3), and biliary excretion. In vitro intrinsic clearance (HLM/hepatocyte) scaled to in vivo is the standard approach.

---

## Toxicity Endpoints

### hERG Channel Liability

**What it measures:** The likelihood of a compound blocking the hERG (human Ether-a-go-go-Related Gene) potassium channel, which is critical for cardiac repolarization.

**Clinical significance:** hERG blockade prolongs the QT interval on ECG, which can lead to Torsades de Pointes, a potentially fatal cardiac arrhythmia. hERG liability is the single most common reason for drug withdrawal from the market. All drug candidates must be tested for hERG activity.

**Pharmacophore basis:** The hERG channel pore is large and hydrophobic. Classical hERG blockers feature: (1) a basic (protonatable) nitrogen, (2) substantial hydrophobic mass (aromatic rings), and (3) appropriate spatial separation (5-10 Angstroms between the cation center and hydrophobic regions).

**Thresholds:**
- GREEN: No structural alerts. Low probability of hERG IC50 < 10 uM.
- YELLOW: 1 alert. Borderline; recommend patch-clamp assay.
- RED: 2+ alerts. High probability of hERG blockade; prioritize for early testing.

**Limitations:** SMARTS-based alerts have high sensitivity but limited specificity (many false positives). The actual hERG IC50 depends on three-dimensional fit in the channel pore, not just the presence of pharmacophoric features. Automated patch-clamp (QPatch, PatchXpress) is the experimental standard.

---

### AMES Mutagenicity

**What it measures:** The likelihood of a compound causing mutations in bacterial DNA, assessed via structural alerts matching known mutagen classes. The AMES test (Salmonella typhimurium reverse mutation assay) is the experimental reference.

**Clinical significance:** A positive AMES test is a regulatory red flag. Under ICH M7 guidelines, mutagenic impurities are controlled to very low levels (Threshold of Toxicological Concern, 1.5 ug/day). A positive AMES result for the API itself can halt development unless the benefit-risk ratio is strongly favorable (e.g., oncology).

**Alert categories covered:**
- Aromatic amines (metabolic activation to nitrenium ions)
- Nitro compounds (nitroreduction to reactive intermediates)
- N-nitroso and azo compounds
- Alkylating agents (epoxides, aziridines, alkyl halides, sulfonate esters)
- Michael acceptors (acrylamides, acrylonitriles, vinyl sulfones)
- Acylating agents (acyl halides, anhydrides)
- Polycyclic aromatic hydrocarbons (bay-region diol-epoxides)
- Intercalators (acridines, quinoxalines)

**Thresholds:**
- GREEN: No structural alerts. Predicted AMES-negative.
- RED: 1+ structural alerts present. Recommend AMES testing before progressing.

**Limitations:** Structural alerts have high sensitivity (~85%) but moderate specificity (~65%). Many compounds with alerting substructures are AMES-negative because the overall molecular context (steric shielding, electronic deactivation, metabolism) prevents mutagenic activity. Conversely, some mutagenic mechanisms are not covered by standard alert libraries. The bacterial AMES assay itself has limited relevance to in vivo mammalian genotoxicity for some compound classes.

---

### Hepatotoxicity (Drug-Induced Liver Injury, DILI)

**What it measures:** The likelihood of a compound causing liver injury, based on structural alerts for substructures associated with DILI in clinical practice or animal studies.

**Clinical significance:** DILI is the most common reason for post-market drug withdrawal and FDA black box warnings. It can manifest as hepatocellular necrosis, cholestasis, steatosis, or mixed patterns. DILI risk assessment is complicated by its often idiosyncratic (unpredictable) nature.

**Alert categories:**
- Reactive metabolite precursors: quinone/quinone imine formation from catechols, hydroquinones, aminophenols, anilides
- Acyl glucuronide formation from carboxylic acids (protein haptenization)
- Hydrazines and thioureas (direct hepatotoxins)
- Nitroaromatics (nitroreduction to reactive intermediates)
- Nitrile groups (cyanide metabolite generation)

**Thresholds:**
- GREEN: No structural alerts.
- YELLOW: 1 alert. Monitor liver function in preclinical studies.
- RED: 2+ alerts. Significant DILI concern; consider structural modification.

**Limitations:** DILI is poorly predicted by any computational method. Idiosyncratic DILI depends on immune-mediated mechanisms, genetic polymorphisms, and metabolic variability that cannot be captured by structural alerts. Reactive metabolite trapping studies (GSH, KCN) and in vitro hepatocyte viability assays provide additional data.

---

### Skin Sensitization

**What it measures:** The likelihood of a compound acting as a skin sensitizer (causing allergic contact dermatitis) based on the presence of electrophilic reactive groups.

**Clinical significance:** Important for topical drugs, cosmetics, and occupational exposure. Skin sensitization follows a haptenization mechanism: the electrophilic drug reacts with skin proteins, forming a hapten-protein conjugate that triggers an immune response.

**Thresholds:**
- GREEN: No reactive electrophile alerts.
- YELLOW: 1 non-high-severity alert.
- RED: 1+ high-severity alert (epoxide, acyl halide, isocyanate).

**Limitations:** Not all electrophiles cause sensitization in practice (depends on concentration, skin penetration, and individual susceptibility). The Direct Peptide Reactivity Assay (DPRA) and KeratinoSens assay are the modern in vitro standards.

---

### Phospholipidosis (Cationic Amphiphilic Drug Liability)

**What it measures:** The likelihood of a compound causing phospholipidosis, a drug-induced lysosomal storage disorder characterized by accumulation of phospholipids in lysosomes.

**Clinical significance:** Phospholipidosis is a common finding in preclinical toxicology studies. While often considered an adaptive response with limited clinical impact, severe phospholipidosis can impair organ function. Cationic amphiphilic drugs (CADs) are the primary risk group.

**CAD criteria:** Basic or cationic nitrogen + LogP > 2 + MW > 300 (amphiphilic character).

**Thresholds:**
- GREEN: Not a CAD. Low phospholipidosis risk.
- YELLOW: Moderate CAD character.
- RED: Strong CAD (basic N, LogP > 4, adequate MW).

**Limitations:** Not all CADs cause clinically relevant phospholipidosis. In vitro phospholipidosis assays (e.g., NBD-PE accumulation in HepG2 cells) provide more accurate assessment.

---

### LD50 Class Estimation

**What it measures:** A rough classification of acute oral toxicity based on the presence of known toxic structural motifs, mapped to GHS acute toxicity classes.

**Clinical significance:** Acute toxicity classification affects labeling, packaging, and handling requirements. For drug candidates, very high acute toxicity (Class 1-2) may limit the therapeutic window.

**GHS Classes:**
- Class 1: LD50 <= 5 mg/kg (fatal)
- Class 2: LD50 5-50 mg/kg (fatal)
- Class 3: LD50 50-300 mg/kg (toxic)
- Class 4: LD50 300-2000 mg/kg (harmful)
- Class 5: LD50 2000-5000 mg/kg (may be harmful)

**Thresholds:**
- GREEN: No highly toxic motifs. Likely Class 4-5.
- YELLOW: Moderate toxic motifs present. Likely Class 3-4.
- RED: Highly toxic motifs (organophosphates, heavy metals, etc.). Likely Class 1-3.

**Limitations:** LD50 depends on the entire molecule, not just substructures. This is the crudest toxicity endpoint predicted by the tool. In vivo or validated in vitro (3T3 NRU) acute toxicity testing is always required.

---

### PAINS (Pan-Assay Interference Compounds)

**What it measures:** Whether a compound contains substructures known to interfere with biological assays through non-specific mechanisms (aggregation, redox cycling, fluorescence quenching, metal chelation, chemical reactivity).

**Clinical significance:** PAINS are not inherently toxic or inactive, but they frequently generate false-positive hits in high-throughput screens. PAINS alerts should prompt additional validation (dose-response, counter-screens, orthogonal assays) rather than automatic rejection.

**Thresholds:**
- GREEN: 0 PAINS alerts.
- YELLOW: 1 PAINS alert.
- RED: 2+ PAINS alerts. High likelihood of assay interference.

**Limitations:** PAINS alerts were derived from AlphaScreen assays and may not generalize to all assay technologies. Some PAINS-flagged compounds are genuine bioactive molecules (e.g., curcumin analogs with validated targets). Context matters.

---

## Drug-Likeness Metrics

### Lipinski Rule of Five

**What it measures:** Compliance with the empirical rules for oral bioavailability derived by Lipinski et al. (1997) from analysis of approved drugs: MW <= 500, LogP <= 5, HBD <= 5, HBA <= 10.

**Thresholds:**
- GREEN: 0 violations. Drug-like.
- YELLOW: 1 violation. Borderline; many approved drugs have 1 violation.
- RED: 2+ violations. Poor oral drug-likeness predicted.

---

### QED (Quantitative Estimate of Drug-likeness)

**What it measures:** A continuous, weighted score (0-1) based on the desirability of eight molecular properties, calibrated against the property distributions of marketed drugs (Bickerton et al. 2012).

**Thresholds:**
- GREEN: QED > 0.67. Good drug-likeness.
- YELLOW: QED 0.49-0.67. Moderate drug-likeness.
- RED: QED < 0.49. Poor drug-likeness.

---

### Synthetic Accessibility (SA Score)

**What it measures:** An estimate of how difficult a compound is to synthesize (1 = easy, 10 = very difficult), based on fragment contributions, ring complexity, stereocenters, and molecular size (Ertl & Schuffenhauer 2009).

**Thresholds:**
- GREEN: SA <= 4. Readily synthesizable.
- YELLOW: SA 4-6. Moderate synthetic challenge.
- RED: SA > 6. Difficult synthesis likely; consider alternative scaffolds.

---

### Fsp3 (Fraction of sp3 Carbons)

**What it measures:** The fraction of carbon atoms that are sp3-hybridized (tetrahedral). Higher Fsp3 indicates greater three-dimensionality.

**Clinical significance:** Higher Fsp3 correlates with improved clinical success rates, likely because three-dimensional molecules have better selectivity and solubility than flat aromatic compounds (Lovering et al. 2009).

**Thresholds:**
- GREEN: Fsp3 >= 0.25.
- YELLOW: Fsp3 0.1-0.25.
- RED: Fsp3 < 0.1. Very flat molecule; consider sp3-rich bioisosteres.

---

## Endpoint Prioritization by Therapeutic Area

### Oncology
**Highest priority:** AMES mutagenicity (often tolerated), hERG, DILI, solubility.
**Lower priority:** Lipinski compliance (many oncology drugs violate Ro5), BBB penetration (usually not desired).

### CNS
**Highest priority:** BBB penetration, Pgp substrate (must not be effluxed), hERG, CYP2D6 (polymorphism risk).
**Lower priority:** Lipinski (CNS drugs are typically well within Ro5).

### Cardiovascular
**Highest priority:** hERG (absolute priority), AMES, DILI, PPB (free fraction matters for narrow therapeutic index).
**Lower priority:** BBB (peripheral target).

### Anti-infectives
**Highest priority:** Solubility, HIA, CYP DDI potential (polypharmacy common), AMES, DILI.
**Lower priority:** BBB (unless targeting CNS infections).

### Topical / Dermatology
**Highest priority:** Skin sensitization, MW/LogP for skin penetration, solubility.
**Lower priority:** HIA, BBB, oral-specific metrics.

### Rare / Orphan Diseases
**Highest priority:** Toxicity endpoints (AMES, hERG, DILI) given small patient populations.
**Lower priority:** Strict drug-likeness rules may be relaxed given unmet need.

---

## General Prioritization Principle

When multiple endpoints flag a compound, prioritize in this order:

1. **Safety-critical endpoints first:** hERG (cardiac death risk), AMES (regulatory showstopper), DILI (most common withdrawal reason).
2. **Efficacy-enabling endpoints second:** Solubility, permeability, BBB (for CNS targets), metabolic stability.
3. **Optimization metrics third:** QED, SA score, Fsp3, Lipinski compliance.

A compound with GREEN toxicity but YELLOW drug-likeness is far preferable to one with GREEN drug-likeness but RED toxicity.
