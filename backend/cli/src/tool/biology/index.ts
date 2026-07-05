export {
  QueryUniprotTool,
  QueryEnsemblTool,
  QueryKeggTool,
  QueryPubmedTool,
  QueryNcbiGeneTool,
  QueryStringTool,
  QueryPdbTool,
} from "./database"
export { NotebookTool } from "./notebook"

import {
  QueryUniprotTool,
  QueryEnsemblTool,
  QueryKeggTool,
  QueryPubmedTool,
  QueryNcbiGeneTool,
  QueryStringTool,
  QueryPdbTool,
} from "./database"
import { NotebookTool } from "./notebook"

export const BiologyTools = [
  QueryUniprotTool,
  QueryEnsemblTool,
  QueryKeggTool,
  QueryPubmedTool,
  QueryNcbiGeneTool,
  QueryStringTool,
  QueryPdbTool,
  NotebookTool,
]

export const BIOLOGY_TOOL_IDS = new Set([
  "query_uniprot",
  "query_ensembl",
  "query_kegg",
  "query_pubmed",
  "query_ncbi_gene",
  "query_string",
  "query_pdb",
  "notebook",
])
