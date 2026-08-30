export default function ChannelsLoading() {
  return (
    <div className="sources-page" aria-busy="true" aria-label="Загрузка каналов">
      <div className="skeleton" style={{ height: "1.4rem", width: "10rem", marginBottom: "0.6rem" }} />
      <div className="skeleton" style={{ height: "0.85rem", width: "24rem", marginBottom: "1.5rem" }} />
      <div className="card" style={{ height: "8rem" }}>
        <div className="skeleton" style={{ height: "100%", width: "100%" }} />
      </div>
      <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card" style={{ height: "4rem" }}>
            <div className="skeleton" style={{ height: "100%", width: "100%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
