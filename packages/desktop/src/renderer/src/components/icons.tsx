import type { AgentKind } from '@kando/protocol'

// Line icons on a 20px grid; they take the button's text color.
const stroked = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

export function PlayIcon() {
  return (
    <svg {...stroked}>
      <path d="M6.5 4.9v10.2a.7.7 0 0 0 1.05.6l8.1-5.1a.7.7 0 0 0 0-1.2l-8.1-5.1a.7.7 0 0 0-1.05.6z" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg {...stroked}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  )
}

export function ReopenIcon() {
  return (
    <svg {...stroked}>
      <path d="M3.5 10a6.5 6.5 0 1 0 6.5-6.5 7 7 0 0 0-4.9 2L3.5 7" />
      <path d="M3.5 3.5V7H7" />
    </svg>
  )
}

export function MoreIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="15" cy="10" r="1.4" />
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg {...stroked}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  )
}

export function ChevronDownIcon() {
  return (
    <svg {...stroked}>
      <path d="M6 8l4 4 4-4" />
    </svg>
  )
}

// Claude's own mark, from Simple Icons 16.32.0 (the drawing is CC0; the logo is Anthropic's trademark).
function ClaudeMark() {
  return (
    <svg className="agent-mark agent-mark-claude" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  )
}

// OpenAI's blossom from openai.com/brand, used under its logo terms: the path unaltered, black or
// white only. The viewBox trims the file's wide margin so it matches Claude's size; some clear space stays.
function CodexMark() {
  return (
    <svg className="agent-mark agent-mark-codex" viewBox="138 138 440 440" fill="currentColor" aria-hidden="true">
      <path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z" />
    </svg>
  )
}

function NoAgentMark() {
  return (
    <svg className="agent-mark agent-mark-none" {...stroked} strokeDasharray="2.4 2.2">
      <rect x="3" y="3" width="14" height="14" rx="4" />
    </svg>
  )
}

export function AgentIcon({ agent }: { agent: AgentKind | null }) {
  switch (agent) {
    case 'claude':
      return <ClaudeMark />
    case 'codex':
      return <CodexMark />
    case null:
      return <NoAgentMark />
  }
}

export function TerminalIcon() {
  return (
    <svg {...stroked}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M6 8l2.5 2L6 12M10.5 12.5H14" />
    </svg>
  )
}

export function DocumentIcon() {
  return (
    <svg {...stroked}>
      <path d="M5.5 2.5h6l3.5 3.5v11a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-14a.5.5 0 0 1 .5-.5z" />
      <path d="M11 2.5V6h3.5M7.5 10h5M7.5 13h5" />
    </svg>
  )
}

export function GearIcon() {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315]
  return (
    <svg {...stroked}>
      <circle cx="10" cy="10" r="4.9" />
      <circle cx="10" cy="10" r="1.9" />
      {teeth.map((angle) => (
        <line key={angle} x1="10" y1="4.4" x2="10" y2="2.4" strokeWidth="2.4" transform={`rotate(${angle} 10 10)`} />
      ))}
    </svg>
  )
}

export function ArrowLeftIcon() {
  return (
    <svg {...stroked}>
      <path d="M16 10H4M9 5l-5 5 5 5" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg {...stroked}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2L17 17" />
    </svg>
  )
}

export function ContrastIcon() {
  return (
    <svg {...stroked}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor" />
    </svg>
  )
}

export function GaugeIcon() {
  return (
    <svg {...stroked}>
      <path d="M3.5 14.5a6.5 6.5 0 1 1 13 0" />
      <path d="M10 14.5l3.2-4.2" />
    </svg>
  )
}

export function SparkIcon() {
  return (
    <svg {...stroked}>
      <path d="M10 2.8l1.7 4.5 4.5 1.7-4.5 1.7L10 15.2l-1.7-4.5L3.8 9l4.5-1.7z" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg {...stroked}>
      <path d="M2.8 5.6A1.6 1.6 0 0 1 4.4 4h3l1.7 1.9h6.5a1.6 1.6 0 0 1 1.6 1.6v6.9a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6z" />
    </svg>
  )
}

export function InfoIcon() {
  return (
    <svg {...stroked}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 9.2v4.6" />
      <circle cx="10" cy="6.4" r="0.6" fill="currentColor" />
    </svg>
  )
}

export function ChatIcon() {
  return (
    <svg {...stroked}>
      <path d="M4.2 4h11.6a1.7 1.7 0 0 1 1.7 1.7v7a1.7 1.7 0 0 1-1.7 1.7H9.4L6 17.2v-2.8H4.2a1.7 1.7 0 0 1-1.7-1.7v-7A1.7 1.7 0 0 1 4.2 4z" />
      <path d="M6.5 8.2h7M6.5 11h4.5" />
    </svg>
  )
}

export function InboxIcon() {
  return (
    <svg {...stroked}>
      <path d="M3 11.5l2-6.4A1.5 1.5 0 0 1 6.4 4h7.2a1.5 1.5 0 0 1 1.4 1.1l2 6.4v3.8a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 15.3z" />
      <path d="M3 11.5h3.8l1 1.8h4.4l1-1.8H17" />
    </svg>
  )
}

export function RefreshIcon() {
  return (
    <svg {...stroked}>
      <path d="M16 9.5A6 6 0 0 0 5.2 6.2L4 7.5" />
      <path d="M4 4.2v3.3h3.3" />
      <path d="M4 10.5a6 6 0 0 0 10.8 3.3l1.2-1.3" />
      <path d="M16 15.8v-3.3h-3.3" />
    </svg>
  )
}

export function ChevronRightIcon() {
  return (
    <svg {...stroked}>
      <path d="M8 6l4 4-4 4" />
    </svg>
  )
}

export function SlidersIcon() {
  return (
    <svg {...stroked}>
      <path d="M6.5 3v7.5M6.5 14.5V17M13.5 3v2.5M13.5 9.5V17" />
      <circle cx="6.5" cy="12.5" r="2" />
      <circle cx="13.5" cy="7.5" r="2" />
    </svg>
  )
}

export function FilterIcon() {
  return (
    <svg {...stroked}>
      <path d="M3.5 4.5h13l-5 6v5l-3 1.5v-6.5z" />
    </svg>
  )
}

export function PencilIcon() {
  return (
    <svg {...stroked}>
      <path d="M13.5 3.8l2.7 2.7-8.9 8.9-3.6.9.9-3.6z" />
      <path d="M11.8 5.5l2.7 2.7" />
    </svg>
  )
}

export function HandoffIcon() {
  return (
    <svg {...stroked}>
      <path d="M11.5 4.5L16 9l-4.5 4.5" />
      <path d="M16 9H9a5 5 0 0 0-5 5v1.5" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg {...stroked}>
      <rect x="5" y="5" width="10" height="10" rx="2" />
    </svg>
  )
}

export function ExternalIcon() {
  return (
    <svg {...stroked}>
      <path d="M11.5 3.5h5v5M16.5 3.5l-7 7" />
      <path d="M14.5 11.5v3.8a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V6.7a1.2 1.2 0 0 1 1.2-1.2h3.8" />
    </svg>
  )
}
