export {
  QueryUniprotTool,
  QueryEnsemblTool,
  QueryKeggTool,
  QueryPubmedTool,
  QueryNcbiGeneTool,
  QueryStringTool,
  QueryPdbTool,
} from "./database"

import {
  QueryUniprotTool,
  QueryEnsemblTool,
  QueryKeggTool,
  QueryPubmedTool,
  QueryNcbiGeneTool,
  QueryStringTool,
  QueryPdbTool,
} from "./database"

export const BiologyTools = [
  QueryUniprotTool,
  QueryEnsemblTool,
  QueryKeggTool,
  QueryPubmedTool,
  QueryNcbiGeneTool,
  QueryStringTool,
  QueryPdbTool,
]

export { BIOLOGY_TOOL_IDS } from "./ids"
