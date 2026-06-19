/* ============================================================
   app.js — Command Deck LP
   - フェードインアニメーション (Intersection Observer)
   - タイピングアニメーション
   ============================================================ */

// フェードイン
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);

document.querySelectorAll('.fade-in').forEach((el) => observer.observe(el));

// タイピングアニメーション（Hero モックアップ）
const typingEl = document.getElementById('typing-demo');
if (typingEl) {
  const commands = ['compact', 'review', 'clear', 'loop', 'init'];
  let ci = 0;
  let charIndex = 0;
  let deleting = false;

  function tick() {
    const word = commands[ci];
    if (!deleting) {
      typingEl.textContent = word.slice(0, charIndex + 1);
      charIndex++;
      if (charIndex === word.length) {
        deleting = true;
        setTimeout(tick, 1500);
        return;
      }
      setTimeout(tick, 100);
    } else {
      typingEl.textContent = word.slice(0, charIndex - 1);
      charIndex--;
      if (charIndex === 0) {
        deleting = false;
        ci = (ci + 1) % commands.length;
        setTimeout(tick, 300);
        return;
      }
      setTimeout(tick, 50);
    }
  }
  tick();
}
