import { Icon, type IconProps as CanonicalProps } from "@synsci/ui/icon"
import type { JSX } from "solid-js"

interface IconProps {
  size?: number
  strokeWidth?: number
  class?: string
  style?: JSX.CSSProperties
}

type Name = CanonicalProps["name"]

const icon =
  (name: Name) =>
  (props: IconProps): JSX.Element => (
    <Icon
      name={name}
      size={!props.size || props.size <= 16 ? "small" : props.size <= 20 ? "normal" : "medium"}
      class={props.class}
      style={{
        width: props.size ? `${props.size}px` : undefined,
        height: props.size ? `${props.size}px` : undefined,
        ...props.style,
      }}
    />
  )

export const IconLayoutGrid = icon("layout-right")
export const IconCpu = icon("providers")
export const IconBraces = icon("code")
export const IconFolderTree = icon("folder")
export const IconRefresh = icon("undo")
export const IconPlus = icon("plus")
export const IconChevronRight = icon("chevron-right")
export const IconChevronDown = icon("chevron-down")
export const IconChevronLeft = icon("arrow-left")
export const IconX = icon("close")
export const IconArrowUp = icon("arrow-up")
export const IconArrowRight = icon("arrow-right")
export const IconStop = icon("stop")
export const IconSettings = icon("settings-gear")
export const IconHome = icon("layout-left")
export const IconFlask = icon("models")
export const IconFile = icon("code-lines")
export const IconFolder = icon("folder")
export const IconUpload = icon("cloud-upload")
export const IconSparkles = icon("models")
export const IconBookOpen = icon("bullet-list")
export const IconActivity = icon("task")
export const IconClock = icon("task")
export const IconCheckCircle = icon("circle-check")
export const IconAlertCircle = icon("circle-x")
export const IconMessageSquare = icon("speech-bubble")
export const IconNetwork = icon("branch")
export const IconTerminal = icon("console")
export const IconBrain = icon("brain")
export const IconAtom = icon("models")
export const IconSearch = icon("magnifying-glass")
export const IconPaperclip = icon("link")
export const IconMoon = icon("circle-ban-sign")
export const IconSun = icon("models")
export const IconStar = icon("models")
export const IconStarFilled = icon("models")
export const IconPin = icon("pin")
export const IconPinFilled = icon("pin-filled")
export const IconExpand = icon("expand")
export const IconCollapse = icon("collapse")
export const IconTrash = icon("trash")
export const IconShare = icon("share")
export const IconDownload = icon("download")
export const IconCopy = icon("copy")
export const IconArchive = icon("archive")
export const IconMoreH = icon("dot-grid")
export const IconLink = icon("link")
export const IconServer = icon("server")
export const IconCloud = icon("cloud")
export const IconFolderAdd = icon("folder-add-left")
