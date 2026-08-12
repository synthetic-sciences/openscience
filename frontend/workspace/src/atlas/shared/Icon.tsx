import { Icon, type IconProps as CanonicalProps } from "@synsci/ui/icon"
import type { JSX } from "solid-js"

interface IconProps {
  size?: number
  strokeWidth?: number
  class?: string
  style?: JSX.CSSProperties
}

type Name = CanonicalProps["name"]

const size = (value = 16) => {
  if (value <= 12) return 12
  if (value <= 16) return 16
  if (value <= 18) return 18
  return 20
}

const weight = (value = 1.5) => Math.min(1.75, Math.max(1.5, value))

const icon =
  (name: Name) =>
  (props: IconProps): JSX.Element => {
    const pixels = () => size(props.size)
    const scale = () => (pixels() <= 16 ? "small" : pixels() === 18 ? "normal" : "medium")
    return (
      <Icon
        name={name}
        size={scale()}
        class={props.class}
        style={{
          width: pixels() === 12 ? "12px" : undefined,
          height: pixels() === 12 ? "12px" : undefined,
          "--icon-stroke-width": weight(props.strokeWidth),
          ...props.style,
        }}
      />
    )
  }

export const IconLayoutGrid = icon("layout-grid")
export const IconSplit = icon("split")
export const IconCpu = icon("cpu")
export const IconBraces = icon("braces")
export const IconFolderTree = icon("folder-tree")
export const IconRefresh = icon("refresh")
export const IconPlus = icon("plus")
export const IconChevronRight = icon("chevron-right")
export const IconChevronDown = icon("chevron-down")
export const IconChevronLeft = icon("chevron-left")
export const IconX = icon("close")
export const IconArrowUp = icon("arrow-up")
export const IconArrowRight = icon("arrow-right")
export const IconStop = icon("stop")
export const IconSettings = icon("settings-gear")
export const IconHome = icon("home")
export const IconFlask = icon("flask")
export const IconFile = icon("file")
export const IconFolder = icon("folder")
export const IconUpload = icon("cloud-upload")
export const IconSparkles = icon("sparkles")
export const IconBookOpen = icon("book-open")
export const IconActivity = icon("activity")
export const IconClock = icon("clock")
export const IconCheckCircle = icon("circle-check")
export const IconAlertCircle = icon("alert-circle")
export const IconMessageSquare = icon("speech-bubble")
export const IconNetwork = icon("network")
export const IconTerminal = icon("console")
export const IconBrain = icon("brain")
export const IconResearch = icon("research")
export const IconArtifact = icon("artifact")
export const IconDatabase = icon("database")
export const IconTable = icon("table")
export const IconAtom = icon("atom")
export const IconSearch = icon("magnifying-glass")
export const IconPaperclip = icon("paperclip")
export const IconMicrophone = icon("microphone")
export const IconShield = icon("shield")
export const IconShieldAlert = icon("shield-alert")
export const IconBolt = icon("bolt")
export const IconMoon = icon("moon")
export const IconSun = icon("sun")
export const IconStar = icon("star")
export const IconStarFilled = icon("star-filled")
export const IconPin = icon("pin")
export const IconPinFilled = icon("pin-filled")
export const IconExpand = icon("expand")
export const IconCollapse = icon("collapse")
export const IconTrash = icon("trash")
export const IconShare = icon("share")
export const IconDownload = icon("download")
export const IconCopy = icon("copy")
export const IconEdit = icon("pencil-line")
export const IconArchive = icon("archive")
export const IconMoreH = icon("more-horizontal")
export const IconLink = icon("link")
export const IconServer = icon("server")
export const IconCloud = icon("cloud")
export const IconFolderAdd = icon("folder-add-left")
