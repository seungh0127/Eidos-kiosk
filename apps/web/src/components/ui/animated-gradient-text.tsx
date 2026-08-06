import type { CSSProperties, HTMLAttributes } from "react";

export type AnimatedGradientTextProps = HTMLAttributes<HTMLSpanElement> & {
  colorFrom?: string;
  colorTo?: string;
  speed?: number;
};

export function AnimatedGradientText({
  colorFrom = "#FFFFFF",
  colorTo = "#A4E8FF",
  speed = 1,
  className = "",
  style,
  ...props
}: AnimatedGradientTextProps) {
  const duration = `${Math.max(0.8, 3 / Math.max(speed, 0.1))}s`;
  const gradientStyle = {
    "--animated-gradient-from": colorFrom,
    "--animated-gradient-to": colorTo,
    "--animated-gradient-duration": duration,
    ...style,
  } as CSSProperties;

  return <span {...props} className={`animated-gradient-text ${className}`.trim()} style={gradientStyle} />;
}
