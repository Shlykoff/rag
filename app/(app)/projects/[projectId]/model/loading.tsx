export default function ModelLoading() {
  return (
    <div className="sources-page" aria-busy="true" aria-label="Загрузка настроек модели">
      {[0, 1].map((i) => (
        <div key={i} className="card" style={{ height: "6rem", marginBottom: "1rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
