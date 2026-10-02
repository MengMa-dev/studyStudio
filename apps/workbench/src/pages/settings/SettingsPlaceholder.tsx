export function SettingsPlaceholder({ title, hint }: { title: string; hint: string }) {
  return (
    <section className="set-group">
      <div className="set-card">
        <div className="set-row">
          <div className="grow">
            <div className="set-label">{title}</div>
            <div className="set-desc">{hint}</div>
          </div>
          <span className="tag">即将推出</span>
        </div>
      </div>
    </section>
  );
}
