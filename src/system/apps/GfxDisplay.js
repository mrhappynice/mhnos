// --- APP: GRAPHICS DISPLAY ---
export class GfxDisplay {
    constructor(os) { this.os = os; }
    open() {
        if(document.getElementById('gfx-container')) return;

        const div = document.createElement('div');
        div.id = 'gfx-container';
        div.style.cssText = "width:100%; height:100%; background:#000; display:flex; justify-content:center; align-items:center;";
        this.os.wm.createWindow('Display', div, { x: 20, y: 400, width: 400, height: 340 });
    }
}


