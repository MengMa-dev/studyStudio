import styles from "./EllipsisText.module.css";
import { Tooltip } from "radix-ui";

type Props = {
  text: string;
  className?: string;
};

export function EllipsisText({ text, className }: Props) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className={`${styles.ellipsis} ${className ?? ""}`}>{text}</span>
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
