import type { ReactNode, SVGProps } from "react";

function Icon({ children, size = 14, ...props }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      {children}
    </svg>
  );
}

const stroke = {
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 2,
} as const;

export const GripIcon = () => (
  <Icon>
    <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" {...stroke} strokeWidth={2.5} />
  </Icon>
);

export const EditIcon = () => (
  <Icon>
    <path d="M4 20h4l10-10-4-4L4 16v4z" {...stroke} />
    <path d="m13 7 4 4" {...stroke} />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M3 6h18" {...stroke} />
    <path d="M8 6V4h8v2" {...stroke} />
    <path d="M19 6v14H5V6" {...stroke} />
    <path d="M10 11v6M14 11v6" {...stroke} />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" {...stroke} />
    <path d="M21 3v6h-6" {...stroke} />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect height="13" rx="2" ry="2" stroke="currentColor" strokeWidth="2" width="13" x="9" y="9" />
    <rect height="13" rx="2" ry="2" stroke="currentColor" strokeWidth="2" width="13" x="2" y="2" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon>
    <path d="M2 12c1-4.2 5-8 10-8s9 3.8 10 8c-1 4.2-5 8-10 8s-9-3.8-10-8Z" {...stroke} />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
  </Icon>
);

export const EyeOffIcon = () => (
  <Icon>
    <path d="M3 3 21 21M10.6 10.6a2 2 0 0 0 2.8 2.8" {...stroke} />
    <path
      d="M9.9 4.2A10.9 10.9 0 0 1 12 4c5 0 9 3.8 10 8-0.4 1.7-1.4 3.2-2.7 4.4M6.1 6.1C4.3 7.6 3.2 9.7 2 12c.8 3.1 3.2 5.7 6.3 7"
      {...stroke}
    />
  </Icon>
);

export const SearchIcon = () => (
  <Icon size={undefined}>
    <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="2" />
    <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon size={undefined}>
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </Icon>
);

export const CheckIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={undefined}>
    <path d="M20 6 9 17l-5-5" {...stroke} />
  </Icon>
);

export const WarningIcon = ({ className }: { className?: string }) => (
  <Icon className={className} size={undefined}>
    <path d="M12 3 2.6 19.5h18.8L12 3Z" {...stroke} />
    <path d="M12 9v5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    <circle cx="12" cy="16.5" fill="currentColor" r="1" />
  </Icon>
);

type IconProps = { size?: number; className?: string };
const make = (paths: ReactNode) =>
  function Glyph({ size = 14, className }: IconProps) {
    return (
      <Icon className={className} size={size}>
        {paths}
      </Icon>
    );
  };

export const GearIcon = make(
  <>
    <circle cx="12" cy="12" r="3" {...stroke} />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" {...stroke} />
  </>,
);
export const PlusIcon = make(<path d="M12 5v14M5 12h14" {...stroke} />);
export const DotsIcon = make(<path d="M5 12h.01M12 12h.01M19 12h.01" {...stroke} strokeWidth={3} />);
export const LockIcon = make(
  <>
    <rect height="10" rx="2" width="14" x="5" y="11" {...stroke} />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" {...stroke} />
  </>,
);
export const PlayIcon = make(<path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />);
export const StopIcon = make(<rect height="12" rx="1.5" width="12" x="6" y="6" fill="currentColor" />);
export const ChevronDownIcon = make(<path d="m6 9 6 6 6-6" {...stroke} />);
export const ChevronRightIcon = make(<path d="m9 6 6 6-6 6" {...stroke} />);
export const ChevronLeftIcon = make(<path d="m15 6-6 6 6 6" {...stroke} />);
export const PinIcon = make(<path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3-1-6Z" {...stroke} />);
export const DatabaseIcon = make(
  <>
    <ellipse cx="12" cy="5" rx="8" ry="3" {...stroke} />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" {...stroke} />
  </>,
);
export const TableIcon = make(
  <>
    <rect height="16" rx="2" width="18" x="3" y="4" {...stroke} />
    <path d="M3 10h18M9 4v16" {...stroke} />
  </>,
);
export const FunctionIcon = make(<path d="m8 6-5 6 5 6M16 6l5 6-5 6" {...stroke} />);
export const KeyIcon = make(
  <>
    <circle cx="8" cy="15" r="4" {...stroke} />
    <path d="m11 12 9-9M16 7l3 3" {...stroke} />
  </>,
);
export const LinkIcon = make(<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" {...stroke} />);
export const ClockIcon = make(
  <>
    <circle cx="12" cy="12" r="9" {...stroke} />
    <path d="M12 7v5l3 2" {...stroke} />
  </>,
);
export const BoltIcon = make(<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" {...stroke} />);
export const ShieldIcon = make(<path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3Z" {...stroke} />);
export const InfoIcon = make(
  <>
    <circle cx="12" cy="12" r="9" {...stroke} />
    <path d="M12 11v5M12 8h.01" {...stroke} />
  </>,
);
export const PlugIcon = make(<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" {...stroke} />);
export const UploadIcon = make(<path d="M12 16V4M7 9l5-5 5 5M4 20h16" {...stroke} />);
export const DownloadIcon = make(<path d="M12 4v12M7 11l5 5 5-5M4 20h16" {...stroke} />);
export const FileIcon = make(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" {...stroke} />
    <path d="M14 3v5h5" {...stroke} />
  </>,
);
export const SaveIcon = make(
  <>
    <path d="M5 4h11l3 3v13H5V4Z" {...stroke} />
    <path d="M8 4v5h7V4M8 20v-6h8v6" {...stroke} />
  </>,
);
export const SparkleIcon = make(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" {...stroke} />);
export const FilterIcon = make(<path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z" {...stroke} />);
export const PinOutlineIcon = PinIcon;
export const TerminalIcon = make(
  <>
    <rect height="16" rx="2" width="18" x="3" y="4" {...stroke} />
    <path d="m7 10 3 2-3 2M13 15h4" {...stroke} />
  </>,
);
export const ExpandIcon = make(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" {...stroke} />);
export const RowsIcon = make(<path d="M4 6h16M4 12h16M4 18h16" {...stroke} />);
export const CommandIcon = make(<path d="M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V9Z" {...stroke} />);
export const ListIcon = make(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...stroke} />);
export const FolderIcon = make(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" {...stroke} />);
