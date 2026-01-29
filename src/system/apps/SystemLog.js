// --- APP: SYSTEM LOG (Console) ---
export class SystemLog {
    constructor(os) { this.os = os; }
    open() {
        // Only allow one log window
        if(document.getElementById('sys-log')) return;
        
        const div = document.createElement('div');
        div.id = 'sys-log';
        div.style.cssText = "background:#000; color:#0f0; height:100%; overflow:auto; padding:10px; font-family:monospace;";
        this.os.wm.createWindow('Kernel Log', div, { x: 500, y: 50, width: 400, height: 250 });
    }
    
    static log(msg) {
        const el = document.getElementById('sys-log');
        if(el) {
            const line = document.createElement('div');
            line.textContent = `> ${msg}`;
            el.appendChild(line);
            el.scrollTop = el.scrollHeight;
        }
    }
}

