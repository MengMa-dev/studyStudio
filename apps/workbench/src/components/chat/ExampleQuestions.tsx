type Props = {
  questions: string[];
  variant: "chips" | "list";
  disabled?: boolean;
  onAsk: (question: string) => void;
};

export function ExampleQuestions({ questions, variant, disabled, onAsk }: Props) {
  return (
    <div className={variant === "chips" ? "chips chat-examples" : "stack chat-examples"} aria-label="示例问题">
      {questions.map((question) => (
        <button key={question} type="button" className={variant === "chips" ? "chip" : "chip dock-suggest"} disabled={disabled} onClick={() => onAsk(question)}>
          {question}
        </button>
      ))}
    </div>
  );
}
