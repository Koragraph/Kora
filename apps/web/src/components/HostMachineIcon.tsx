import { LinuxIcon } from "./BrandIcons";
import type { HostMachineKind } from "@kora/contracts";
import type { FunctionComponent, SVGProps } from "react";
import { type LucideProps, MonitorIcon, LaptopIcon, ServerIcon, CloudIcon } from "lucide-react";

// Lucide has no Apple desktops, so these two are drawn to its grammar (24
// unit grid, 2 unit stroke, round joins) and share its prop surface so callers
// can swap freely.
function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      strokeLinejoin="round"
      strokeLinecap="round"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth="2"
      height="24"
      fill="none"
      width="24"
      {...props}
    />
  );
}

/** A Mac mini: squat rounded slab with a front-edge LED. */
function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  const lucideLikeKids = (
    <>
      <rect width="20" height="8" rx="2" y="8" x="2" />
      <path d="M6 12h.01" />
    </>
  );

  return <LucideLike {...props}>{lucideLikeKids}</LucideLike>;
}

/** A Mac Studio: the same slab twice as tall, ports along the front foot. */
function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect height="14" width="18" rx="2" y="5" x="3" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </LucideLike>
  );
}

const ICON_BY_KIND: Record<HostMachineKind, FunctionComponent<LucideProps>> = {
  "mac-studio": MacStudioIcon,
  "mac-mini": MacMiniIcon,
  laptop: LaptopIcon,
  desktop: MonitorIcon,
  linux: LinuxIcon,
  cloud: CloudIcon,
  server: ServerIcon,
};

export function HostMachineIcon({
  kind,
  ...props
}: LucideProps & { readonly kind: HostMachineKind }) {
  const Icon = ICON_BY_KIND[kind];
  return <Icon {...props} />;
}
