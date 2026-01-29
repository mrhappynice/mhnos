// --- APP: SETTINGS ---
export class SettingsApp {
    constructor(os) { this.os = os; }
    open() {
        const content = document.createElement('div');
        content.style.cssText = "padding:20px; color: var(--text-color);";
        content.innerHTML = `
            <h3>System Appearance</h3>
            <label>Accent Color:</label>
            <input type="color" id="set-accent" value="#0078d7"><br><br>
            <button id="set-dark">Dark Mode</button> 
            <button id="set-light">Light Mode</button><br><br>
            <label>Wallpaper URL:</label><br>
            <input type="text" id="set-bg" style="width:100%" placeholder="https://...">
        `;
        
        // Logic
        content.querySelector('#set-accent').onchange = (e) => {
            document.documentElement.style.setProperty('--os-accent', e.target.value);
        };
        content.querySelector('#set-dark').onclick = () => document.body.classList.add('dark-mode');
        content.querySelector('#set-light').onclick = () => document.body.classList.remove('dark-mode');
        content.querySelector('#set-bg').onchange = (e) => {
            document.documentElement.style.setProperty('--os-bg', `url('${e.target.value}')`);
        };

        this.os.wm.createWindow('Settings', content, { width: 300, height: 350 });
    }
}

