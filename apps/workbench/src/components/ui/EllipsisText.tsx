import { useRef, useState } from "react";
import styles from "./EllipsisText.module.css";
import { Tooltip } from "radix-ui";

type Props = {
  text: string;
  className?: string;
};

export function EllipsisText({ text, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root
        open={open}
        onOpenChange={(next) => {
          const el = ref.current;
          setOpen(next && !!el && el.scrollWidth > el.clientWidth);
        }}
      >
        <Tooltip.Trigger asChild>
          <span ref={ref} className={`${styles.ellipsis} ${className ?? ""}`}>
            {text}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={styles.tooltip} sideOffset={6}>
            {text}
            <Tooltip.Arrow className={styles.arrow} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
