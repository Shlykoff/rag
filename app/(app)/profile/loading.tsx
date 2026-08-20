export default function ProfileLoading() {
  return (
    <div className="sources-page" aria-busy="true" aria-label="Загрузка настроек AI-провайдеров">
      <div className="skeleton" style={{ height: "1.4rem", width: "12rem", marginBottom: "0.6rem" }} />
      <div className="skeleton" style={{ height: "0.85rem", width: "26rem", marginBottom: "1.5rem" }} />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card" style={{ height: "6rem", marginBottom: "1rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
