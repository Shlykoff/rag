export default function DocumentsLoading() {
  return (
    <div className="sources-page" aria-busy="true" aria-label="Загрузка документов">
      <div className="skeleton" style={{ height: "1.4rem", width: "14rem", marginBottom: "0.6rem" }} />
      <div className="skeleton" style={{ height: "0.85rem", width: "22rem", marginBottom: "1.5rem" }} />
      <div className="card" style={{ height: "10rem" }}>
        <div className="skeleton" style={{ height: "100%", width: "100%" }} />
      </div>
      <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "0.7rem" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card" style={{ height: "4.5rem" }}>
            <div className="skeleton" style={{ height: "100%", width: "100%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
