import { type JSX } from "solid-js"

interface IconProps {
  size?: number
  strokeWidth?: number
  class?: string
  style?: JSX.CSSProperties
}

const baseProps = (props: IconProps) => ({
  width: props.size ?? 12,
  height: props.size ?? 12,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": String(props.strokeWidth ?? 1.5),
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  class: props.class,
  style: props.style,
})

export const IconLayoutGrid = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </svg>
)

export const IconCpu = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <rect width="16" height="16" x="4" y="4" rx="2" />
    <rect width="6" height="6" x="9" y="9" rx="1" />
    <path d="M15 2v2" />
    <path d="M15 20v2" />
    <path d="M9 2v2" />
    <path d="M9 20v2" />
    <path d="M2 15h2" />
    <path d="M2 9h2" />
    <path d="M20 15h2" />
    <path d="M20 9h2" />
  </svg>
)

export const IconBraces = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
    <path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
  </svg>
)

export const IconFolderTree = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" />
    <path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" />
    <path d="M3 5a2 2 0 0 0 2 2h3" />
    <path d="M3 3v13a2 2 0 0 0 2 2h3" />
  </svg>
)

export const IconRefresh = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
)

export const IconPlus = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
)

export const IconChevronRight = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="m9 18 6-6-6-6" />
  </svg>
)

export const IconChevronDown = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const IconChevronLeft = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="m15 18-6-6 6-6" />
  </svg>
)

export const IconX = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export const IconArrowUp = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </svg>
)

export const IconArrowRight = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
)

export const IconStop = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <rect width="14" height="14" x="5" y="5" rx="1" />
  </svg>
)

export const IconSettings = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const IconHome = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
)

export const IconFlask = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M10 2v7.31" />
    <path d="M14 9.3V1.99" />
    <path d="M8.5 2h7" />
    <path d="M14 9.3a6.5 6.5 0 1 1-4 0" />
  </svg>
)

export const IconFile = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
)

export const IconFolder = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)

export const IconUpload = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" x2="12" y1="3" y2="15" />
  </svg>
)

export const IconSparkles = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
    <path d="M4 17v2" />
    <path d="M5 18H3" />
  </svg>
)

export const IconBookOpen = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
)

export const IconActivity = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.5.5 0 0 1-.96 0L9.24 2.18a.5.5 0 0 0-.96 0l-2.35 8.36A2 2 0 0 1 4 12H2" />
  </svg>
)

export const IconClock = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
)

export const IconCheckCircle = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
)

export const IconAlertCircle = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </svg>
)

export const IconMessageSquare = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

export const IconNetwork = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <rect x="16" y="16" width="6" height="6" rx="1" />
    <rect x="2" y="16" width="6" height="6" rx="1" />
    <rect x="9" y="2" width="6" height="6" rx="1" />
    <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
    <path d="M12 12V8" />
  </svg>
)

export const IconTerminal = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" x2="20" y1="19" y2="19" />
  </svg>
)

export const IconBrain = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
  </svg>
)

export const IconAtom = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <circle cx="12" cy="12" r="1" />
    <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
    <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
  </svg>
)

export const IconSearch = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)

export const IconPaperclip = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)

export const IconMoon = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
)

export const IconSun = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
)

export const IconStar = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

export const IconStarFilled = (p: IconProps): JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={p.size ?? 12}
    height={p.size ?? 12}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    stroke-width={String(p.strokeWidth ?? 1.7)}
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    style={p.style}
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

export const IconTrash = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </svg>
)

export const IconShare = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" x2="12" y1="2" y2="15" />
  </svg>
)

export const IconDownload = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </svg>
)

export const IconCopy = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
)

export const IconArchive = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
)

export const IconMoreH = (p: IconProps): JSX.Element => (
  <svg xmlns="http://www.w3.org/2000/svg" {...baseProps(p)}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
)
