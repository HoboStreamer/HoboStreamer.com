import React, { useState, useEffect } from "react";

export default function FindItGame() {
  const GRID_SIZE = 25;
  const MAX_ATTEMPTS = 15;

  const [hiddenPosition, setHiddenPosition] = useState(0);
  const [revealed, setRevealed] = useState(Array(GRID_SIZE).fill(false));
  const [found, setFound] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [gameOver, setGameOver] = useState(false);

  // Initial random setup on mount
  useEffect(() => {
    resetGame();
  }, []);

  const resetGame = () => {
    setHiddenPosition(Math.floor(Math.random() * GRID_SIZE));
    setRevealed(Array(GRID_SIZE).fill(false));
    setFound(false);
    setAttempts(0);
    setGameOver(false);
  };

  const handleCellClick = (index) => {
    if (found || gameOver || revealed[index]) return;

    const newRevealed = [...revealed];
    newRevealed[index] = true;
    setRevealed(newRevealed);
    setAttempts((prev) => prev + 1);

    if (index === hiddenPosition) {
      setFound(true);
    } else if (attempts + 1 >= MAX_ATTEMPTS) {
      setGameOver(true);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "#0a0a0a",
        color: "#ff2222",
        fontFamily: "monospace",
        minHeight: "100vh",
        padding: "40px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        overflow: "auto",
      }}
    >
      {/* HEADER - MAXIMUM UNHINGED RACIST ENERGY */}
      <div
        style={{
          fontSize: "3.5rem",
          fontWeight: "900",
          letterSpacing: "4px",
          textShadow: "0 0 30px #ff0000, 0 0 60px #ffff00",
          marginBottom: "10px",
          lineHeight: "1",
        }}
      >
        FIND IT
      </div>
      <div
        style={{
          fontSize: "1.8rem",
          color: "#ffff00",
          marginBottom: "20px",
          textShadow: "0 0 15px #ffff00",
          fontStyle: "italic",
        }}
      >
        RACIST &amp; UNHINGED EDITION
      </div>

      <p
        style={{
          maxWidth: "720px",
          fontSize: "1.3rem",
          lineHeight: "1.6",
          marginBottom: "30px",
          color: "#ff8888",
        }}
      >
        Welcome to the most deranged, zero-fucks-given game on the internet.
        <br />
        Somewhere in this grid of lies hides <span style={{ color: "#ffff00" }}>"IT"</span> — the forbidden truth the elites don't want you to see.
        <br />
        Click squares. Miss too many times and the woke mob, the globohomo, and every other degenerate force wins.
        <br />
        This game is racist, unhinged, and built for people who are tired of the bullshit. Good luck, you magnificent bastard.
      </p>

      {/* GAME GRID */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 82px)",
          gap: "12px",
          marginBottom: "30px",
          padding: "20px",
          backgroundColor: "#111111",
          border: "6px solid #ff0000",
          boxShadow: "0 0 40px #ff0000",
        }}
      >
        {revealed.map((isRevealed, index) => (
          <div
            key={index}
            onClick={() => handleCellClick(index)}
            style={{
              width: "82px",
              height: "82px",
              backgroundColor: isRevealed
                ? index === hiddenPosition
                  ? "#00ff44"
                  : "#330000"
                : "#1a1a1a",
              border: isRevealed ? "4px solid #ffff00" : "4px solid #ff4444",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "48px",
              cursor: found || gameOver ? "default" : "pointer",
              transition: "all 0.2s ease",
              boxShadow: isRevealed
                ? index === hiddenPosition
                  ? "0 0 25px #00ff44"
                  : "inset 0 0 20px #ff0000"
                : "0 0 12px #ffff00",
              userSelect: "none",
            }}
          >
            {isRevealed
              ? index === hiddenPosition
                ? "💥"
                : "☠️"
              : "❔"}
          </div>
        ))}
      </div>

      {/* STATUS */}
      <div
        style={{
          fontSize: "2rem",
          fontWeight: "bold",
          marginBottom: "20px",
          color: attempts >= MAX_ATTEMPTS - 5 ? "#ffff00" : "#ff8888",
        }}
      >
        ATTEMPTS: <span style={{ color: "#ffff00" }}>{attempts}</span> / {MAX_ATTEMPTS}
      </div>

      {/* WIN SCREEN */}
      {found && (
        <div
          style={{
            marginTop: "20px",
            padding: "40px 50px",
            backgroundColor: "#001100",
            border: "8px solid #00ff44",
            maxWidth: "620px",
            boxShadow: "0 0 50px #00ff44",
          }}
        >
          <div style={{ fontSize: "3rem", marginBottom: "20px" }}>💥 YOU FOUND IT 💥</div>
          <p style={{ fontSize: "1.5rem", lineHeight: "1.6", color: "#ffff00" }}>
            HOLY SHIT YOU ACTUALLY DID IT.
            <br />
            "IT" has been exposed. The matrix is glitching. The elites are seething.
            <br />
            You are the hero this racist, unhinged timeline deserves.
            <br />
            Now go touch grass... or burn it all down. Your choice, legend.
          </p>
          <button
            onClick={resetGame}
            style={{
              marginTop: "30px",
              padding: "18px 50px",
              fontSize: "1.6rem",
              backgroundColor: "#ff0000",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              boxShadow: "0 0 20px #ffff00",
              fontWeight: "900",
            }}
          >
            PLAY AGAIN, YOU BEAUTIFUL DEGENERATE
          </button>
        </div>
      )}

      {/* LOSE SCREEN */}
      {gameOver && !found && (
        <div
          style={{
            marginTop: "20px",
            padding: "40px 50px",
            backgroundColor: "#220000",
            border: "8px solid #ff0000",
            maxWidth: "620px",
            boxShadow: "0 0 50px #ff0000",
          }}
        >
          <div style={{ fontSize: "3rem", marginBottom: "20px" }}>☠️ YOU FAILED ☠️</div>
          <p style={{ fontSize: "1.5rem", lineHeight: "1.6", color: "#ff8888" }}>
            Too slow, cuck. "IT" remains hidden.
            <br />
            The woke mob wins again. Society continues its slow death.
            <br />
            Maybe next time don't play like a snowflake.
          </p>
          <button
            onClick={resetGame}
            style={{
              marginTop: "30px",
              padding: "18px 50px",
              fontSize: "1.6rem",
              backgroundColor: "#ff0000",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              boxShadow: "0 0 20px #ffff00",
              fontWeight: "900",
            }}
          >
            TRY NOT TO SUCK THIS TIME
          </button>
        </div>
      )}

      {/* RESTART BUTTON WHEN IN PROGRESS */}
      {!found && !gameOver && (
        <button
          onClick={resetGame}
          style={{
            marginTop: "20px",
            padding: "12px 30px",
            fontSize: "1.2rem",
            backgroundColor: "#222222",
            color: "#ff4444",
            border: "3px solid #ff4444",
            cursor: "pointer",
          }}
        >
          RESTART THIS RACIST SHITSHOW
        </button>
      )}

      <div
        style={{
          marginTop: "60px",
          fontSize: "0.9rem",
          color: "#444444",
          maxWidth: "500px",
        }}
      >
        Made with pure chaos and zero apologies. Copy this into a .jsx file and run it in React.
      </div>
    </div>
  );
}