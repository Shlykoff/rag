export default function ProjectShellLoading() {
  return (
    <div className="project-shell" aria-busy="true" aria-label="Загрузка проекта">
      <div className="project-header">
        <div className="skeleton" style={{ height: "0.8rem", width: "7rem", marginBottom: "0.5rem" }} />
        <div className="skeleton" style={{ height: "1.5rem", width: "14rem" }} />
      </div>
      <div style={{ padding: "1rem 1.25rem" }}>
        <div className="skeleton" style={{ height: "2.2rem", width: "100%", maxWidth: "64rem", margin: "0 auto" }} />
      </div>
    </div>
  );
}
