// Small inline-SVG icons — one consistent stroke set to replace the emoji that
// were doing UI duty (they render differently per device and read informal).
// Each takes an optional size; color follows `currentColor`, so an icon inherits
// its button's text color.
function Svg({ size = 15, children, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0, ...style }}>
      {children}
    </svg>
  );
}

export const IconHelp   = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .8-1 1.7" /><path d="M12 17h.01" /></Svg>;
export const IconUpload = (p) => <Svg {...p}><path d="M12 15V4" /><path d="M7 9l5-5 5 5" /><path d="M5 19h14" /></Svg>;
export const IconGlobe  = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></Svg>;
export const IconSparkle= (p) => <Svg {...p}><path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z" /></Svg>;
export const IconLock   = (p) => <Svg {...p}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>;
export const IconUnlock = (p) => <Svg {...p}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-2" /></Svg>;
export const IconEye    = (p) => <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const IconCheck  = (p) => <Svg {...p}><path d="M5 12l5 5L20 6" /></Svg>;
