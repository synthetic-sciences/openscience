/** The biological query tools, as a leaf module: the agent registry names
 * them without importing the tool implementations (an import cycle). */
export const BIOLOGY_TOOL_IDS: ReadonlySet<string> = new Set([
  "query_uniprot",
  "query_ensembl",
  "query_kegg",
  "query_pubmed",
  "query_ncbi_gene",
  "query_string",
  "query_pdb",
])
