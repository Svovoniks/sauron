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
