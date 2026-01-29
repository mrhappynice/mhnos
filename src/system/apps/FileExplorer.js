import * as fs from '../../kernel/fs.js';

// --- APP: FILE EXPLORER ---
export class FileExplorer {
    constructor(os) {
        this.os = os;
        this.currentPath = '/';
        this.selectedPaths = new Set();
    }
    
    async open(startPath = '/') {
        this.currentPath = startPath;
        const win = this.os.wm.createWindow('File Explorer', this.render(), { width: 350, height: 400 });
        this.windowBody = win.querySelector('.window-body'); // Store ref to update later
        this.refresh();
    }
    
    render() {
        const div = document.createElement('div');
        div.className = 'file-explorer';
        div.innerHTML = `
            <style>
                .file-explorer {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    background: #0f1115;
                    color: #e6e6e6;
                }
                .file-explorer .fe-toolbar {
                    padding: 6px;
                    border-bottom: 1px solid #252b36;
                    background: #151a23;
                    display: flex;
                    gap: 6px;
                    align-items: center;
                }
                .file-explorer .fe-toolbar button {
                    background: #1f2633;
                    color: #e6e6e6;
                    border: 1px solid #2c3442;
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                .file-explorer .fe-toolbar button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .file-explorer .fe-path {
                    flex: 1;
                    background: #0f141c;
                    color: #cdd7e1;
                    border: 1px solid #2c3442;
                    padding: 4px 6px;
                    border-radius: 4px;
                }
                .file-explorer .file-list {
                    flex: 1;
                    overflow: auto;
                    padding: 6px;
                }
                .file-explorer .fe-row {
                    padding: 6px 8px;
                    cursor: pointer;
                    border-bottom: 1px solid #1f2530;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    user-select: none;
                }
                .file-explorer .fe-row:hover {
                    background: #1b2230;
                }
                .file-explorer .fe-row-selected {
                    background: #273349;
                }
                .file-explorer .fe-checkbox {
                    accent-color: #4aa3ff;
                }
                .file-explorer .fe-icon {
                    width: 18px;
                    text-align: center;
                }
            </style>
            <div class="fe-toolbar">
                <button id="fe-up">⬆ Up</button>
                <button id="fe-delete" disabled>🗑 Delete</button>
                <input type="text" id="fe-path" class="fe-path" value="${this.currentPath}" readonly>
            </div>
            <div class="file-list"></div>
        `;
        
        div.querySelector('#fe-up').onclick = () => this.goUp();
        div.querySelector('#fe-delete').onclick = () => this.deleteSelected();
        return div;
    }
    
    goUp() {
        if(this.currentPath === '/') return;
        const parts = this.currentPath.split('/');
        parts.pop();
        this.currentPath = parts.join('/') || '/';
        this.clearSelection();
        this.refresh();
    }

    async refresh() {
        const listContainer = this.windowBody.querySelector('.file-list');
        const pathInput = this.windowBody.querySelector('#fe-path');
        
        pathInput.value = this.currentPath;
        listContainer.innerHTML = 'Loading...';
        
        const res = await fs.listFiles(this.currentPath);
        listContainer.innerHTML = '';

        if(res.data) {
            res.data.forEach(item => {
                const row = document.createElement('div');
                const isDir = item.type === 'directory';
                const icon = isDir ? '📁' : '📄';
                const fullPath = this.currentPath === '/' 
                    ? `/${item.name}` 
                    : `${this.currentPath}/${item.name}`;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'fe-checkbox';
                checkbox.checked = this.selectedPaths.has(fullPath);

                const iconSpan = document.createElement('span');
                iconSpan.className = 'fe-icon';
                iconSpan.textContent = icon;

                const nameSpan = document.createElement('span');
                nameSpan.textContent = item.name;
                
                row.className = 'fe-row';
                if (checkbox.checked) row.classList.add('fe-row-selected');
                row.appendChild(checkbox);
                row.appendChild(iconSpan);
                row.appendChild(nameSpan);
                
                row.ondblclick = () => {
                    if(isDir) {
                        this.currentPath = this.currentPath === '/' 
                            ? `/${item.name}` 
                            : `${this.currentPath}/${item.name}`;
                        this.clearSelection();
                        this.refresh();
                    } else {
                        // Open File
                        this.os.shell.execute(`edit ${fullPath}`);
                    }
                };
                row.onclick = (e) => {
                    if (e.target === checkbox) return;
                    checkbox.checked = !checkbox.checked;
                    this.setSelection(fullPath, checkbox.checked);
                    this.updateRowSelection(row, checkbox.checked);
                };
                checkbox.onchange = () => {
                    this.setSelection(fullPath, checkbox.checked);
                    this.updateRowSelection(row, checkbox.checked);
                };
                listContainer.appendChild(row);
            });
        }
        this.updateDeleteButtonState();
    }

    setSelection(path, isSelected) {
        if (isSelected) this.selectedPaths.add(path);
        else this.selectedPaths.delete(path);
    }

    updateRowSelection(row, isSelected) {
        row.classList.toggle('fe-row-selected', isSelected);
        this.updateDeleteButtonState();
    }

    updateDeleteButtonState() {
        const deleteBtn = this.windowBody.querySelector('#fe-delete');
        if (deleteBtn) deleteBtn.disabled = this.selectedPaths.size === 0;
    }

    clearSelection() {
        this.selectedPaths.clear();
    }

    async deleteSelected() {
        if (this.selectedPaths.size === 0) return;
        const items = Array.from(this.selectedPaths);
        const confirmDelete = confirm(`Delete ${items.length} item${items.length === 1 ? '' : 's'}?`);
        if (!confirmDelete) return;

        const failures = [];
        for (const path of items) {
            const res = await fs.remove(path);
            if (!res.success) failures.push({ path, error: res.error });
        }
        this.clearSelection();
        await this.refresh();

        if (failures.length > 0) {
            alert(`Failed to delete ${failures.length} item${failures.length === 1 ? '' : 's'}.`);
        }
    }
}
