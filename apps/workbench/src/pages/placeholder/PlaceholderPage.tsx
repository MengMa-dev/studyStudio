export function PlaceholderPage({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <div className="page-header">
        <h1>{title}</h1>
        <span className="sub">{hint}</span>
      </div>
      <div className="card empty">此页面将在后续里程碑实现</div>
    </>
  );
}
