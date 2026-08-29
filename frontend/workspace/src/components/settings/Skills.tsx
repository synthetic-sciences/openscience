import { type ParentComponent } from "solid-js"
import SkillsPage from "@/atlas/SkillsPage"
import "./skills.css"

export { skillIconFor, SkillStateBadges } from "@/atlas/SkillsPage"

export const SkillsFrame: ParentComponent = (props) => (
  <section class="settings-skills" aria-label="Skills settings">
    {props.children}
  </section>
)

const Skills = () => (
  <SkillsFrame>
    <SkillsPage embedded />
  </SkillsFrame>
)

export default Skills
