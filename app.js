// ─── Supabase config ──────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://zcuyzifghtheqlfylnix.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjdXl6aWZnaHRoZXFsZnlsbml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyOTI3NzEsImV4cCI6MjA4Njg2ODc3MX0.pAIYwJpt6Hapfy0wPzIuZjg3_Lqa6h1MoHEOFSYaUCk';
const SUPABASE_ROW_ID = 'default';
const SUPABASE_TABLE = 'meal_plan_data';

// ─── Data ─────────────────────────────────────────────────────────────────────
let recipes = [];
let mealPlan = {}; // { memberId: { day: { meal: recipeId } } }
let householdMembers = [];
let pantryItems = [];
let currentMember = null;
let shoppingList = []; // [{ name, total, checked }]

// ─── Sync state ───────────────────────────────────────────────────────────────
let syncDebounceTimer = null;
let isSyncing = false;

// ─── Sidebar sort state ────────────────────────────────────────────────────────
const SORT_MODES = ['az', 'za', 'recent'];
const SORT_LABELS = { az: 'A–Z', za: 'Z–A', recent: 'Recent' };
let sidebarSortMode = 'az';

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function supabaseFetch(method, body = null) {
    const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${SUPABASE_ROW_ID}`;
    const opts = {
        method,
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal'
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${method} failed: ${res.status} ${text}`);
    }
    return res;
}

async function supabaseLoad() {
    const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${SUPABASE_ROW_ID}&select=data`;
    const res = await fetch(url, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });
    if (!res.ok) throw new Error(`Supabase load failed: ${res.status}`);
    const rows = await res.json();
    return rows.length > 0 ? rows[0].data : null;
}

async function supabaseSave(payload) {
    // Upsert (insert or update)
    await supabaseFetch('POST', { id: SUPABASE_ROW_ID, data: payload });
}

// ─── Sync status UI ───────────────────────────────────────────────────────────
function setSyncStatus(state) {
    // states: 'saved' | 'saving' | 'error' | 'offline' | 'loading'
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.className = 'sync-status ' + state;
    const labels = {
        saved:   '✓ Saved',
        saving:  '⟳ Saving…',
        error:   '⚠ Save failed',
        offline: '○ Offline',
        loading: '⟳ Loading…'
    };
    el.textContent = labels[state] || '';
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function getPayload() {
    return { recipes, mealPlan, householdMembers, currentMember, pantryItems, shoppingList };
}

function applyPayload(parsed) {
    recipes         = parsed.recipes         || [];
    mealPlan        = parsed.mealPlan        || {};
    householdMembers= parsed.householdMembers|| [];
    currentMember   = parsed.currentMember   || null;
    pantryItems     = parsed.pantryItems     || [];
    shoppingList    = parsed.shoppingList    || [];
}

// Write to localStorage immediately (so offline still works)
// then debounce a push to Supabase
function saveData() {
    const payload = getPayload();
    localStorage.setItem('mealPlanApp', JSON.stringify(payload));

    // Debounce cloud save by 800 ms so rapid changes batch together
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => pushToSupabase(payload), 800);
}

async function pushToSupabase(payload) {
    if (isSyncing) return;
    isSyncing = true;
    setSyncStatus('saving');
    try {
        await supabaseSave(payload);
        setSyncStatus('saved');
    } catch (err) {
        console.warn('Supabase save error:', err);
        setSyncStatus('error');
    } finally {
        isSyncing = false;
    }
}

async function loadData() {
    // 1. Load localStorage immediately so the UI is usable right away
    const local = localStorage.getItem('mealPlanApp');
    if (local) {
        try { applyPayload(JSON.parse(local)); } catch (e) { /* ignore */ }
    }

    // 2. Try to load from Supabase (authoritative source)
    setSyncStatus('loading');
    try {
        const remote = await supabaseLoad();
        if (remote) {
            // Merge strategy: remote wins (it's the cross-device source of truth)
            applyPayload(remote);
            // Update localStorage with the fresh remote data
            localStorage.setItem('mealPlanApp', JSON.stringify(remote));
            setSyncStatus('saved');
        } else if (local) {
            // No remote data yet — push local data up as the initial state
            setSyncStatus('saving');
            await supabaseSave(JSON.parse(local));
            setSyncStatus('saved');
        } else {
            setSyncStatus('saved');
        }
    } catch (err) {
        console.warn('Supabase load error — running offline:', err);
        setSyncStatus('offline');
    }
}

// ─── Initialize app ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    setSyncStatus('loading');
    await loadData();
    initializeNavigation();
    initializeRecipeBook();
    initializeHousehold();
    initializeMealPlan();
    initializeShoppingList();
    renderShoppingList();
});

// Navigation
function initializeNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            switchSection(section);
        });
    });
}

function switchSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(sectionId).classList.add('active');
    document.querySelector(`[data-section="${sectionId}"]`).classList.add('active');

    if (sectionId === 'meal-plan') {
        renderSidebarRecipes();
        renderHouseholdSelector();
        renderMealPlan();
    } else if (sectionId === 'recipes') {
        renderRecipes();
    }
}

// Household Management
function initializeHousehold() {
    const manageBtn = document.getElementById('manage-household-btn');
    const modal = document.getElementById('household-modal');
    const closeBtn = modal.querySelector('.close');
    const addMemberBtn = document.getElementById('add-member-btn');

    manageBtn.addEventListener('click', () => {
        openHouseholdModal();
    });

    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    addMemberBtn.addEventListener('click', () => {
        addHouseholdMember();
    });

    // Initialize with default member if empty
    if (householdMembers.length === 0) {
        householdMembers.push({
            id: Date.now(),
            name: 'Me',
            mealsPerDay: 3
        });
        currentMember = householdMembers[0].id;
        saveData();
    } else if (!currentMember) {
        currentMember = householdMembers[0].id;
    }

    // Migrate old format if needed
    householdMembers.forEach(member => {
        if (member.meals && typeof member.meals === 'object') {
            const mealCount = Object.values(member.meals).filter(v => v).length;
            member.mealsPerDay = mealCount;
            delete member.meals;
        }
    });
}

function openHouseholdModal() {
    const modal = document.getElementById('household-modal');
    renderHouseholdMembers();
    modal.classList.add('active');
}

function renderHouseholdMembers() {
    const membersList = document.getElementById('household-members-list');

    membersList.innerHTML = householdMembers.map(member => `
        <div class="member-item">
            <div style="display: flex; gap: 15px; align-items: center; margin-bottom: 10px;">
                <div style="flex: 1;">
                    <label style="display: block; margin-bottom: 5px; font-weight: bold;">Name:</label>
                    <input type="text" value="${member.name}" onchange="updateMemberName(${member.id}, this.value)" placeholder="Member name">
                </div>
                <div style="width: 150px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: bold;">Meals per day:</label>
                    <input type="number" min="1" max="10" value="${member.mealsPerDay || 3}" onchange="updateMemberMealsPerDay(${member.id}, parseInt(this.value))" style="width: 100%;">
                </div>
            </div>
            ${householdMembers.length > 1 ? `<button class="btn-danger" onclick="deleteHouseholdMember(${member.id})">Remove</button>` : ''}
        </div>
    `).join('');
}

function addHouseholdMember() {
    const newMember = {
        id: Date.now(),
        name: 'New Member',
        mealsPerDay: 3
    };
    householdMembers.push(newMember);
    saveData();
    renderHouseholdMembers();
    renderHouseholdSelector();
}

function updateMemberName(memberId, name) {
    const member = householdMembers.find(m => m.id === memberId);
    if (member) {
        member.name = name;
        saveData();
        renderHouseholdSelector();
    }
}

function updateMemberMealsPerDay(memberId, count) {
    const member = householdMembers.find(m => m.id === memberId);
    if (member && count >= 1 && count <= 10) {
        member.mealsPerDay = count;
        saveData();
        renderMealPlan();
    }
}

function deleteHouseholdMember(memberId) {
    if (householdMembers.length === 1) {
        alert('You must have at least one household member');
        return;
    }

    if (confirm('Are you sure you want to remove this member?')) {
        householdMembers = householdMembers.filter(m => m.id !== memberId);
        delete mealPlan[memberId];

        if (currentMember === memberId) {
            currentMember = householdMembers[0].id;
        }

        saveData();
        renderHouseholdMembers();
        renderHouseholdSelector();
        renderMealPlan();
    }
}

function renderHouseholdSelector() {
    const selector = document.getElementById('household-selector');

    selector.innerHTML = `
        <div class="household-tabs">
            ${householdMembers.map(member => `
                <div class="household-tab ${currentMember === member.id ? 'active' : ''}" onclick="switchHouseholdMember(${member.id})">
                    ${member.name}
                </div>
            `).join('')}
        </div>
    `;
}

function switchHouseholdMember(memberId) {
    currentMember = memberId;
    renderHouseholdSelector();
    renderMealPlan();
}

// Recipe Book
function initializeRecipeBook() {
    const addRecipeBtn = document.getElementById('add-recipe-btn');
    const modal = document.getElementById('recipe-modal');
    const closeBtn = modal.querySelector('.close');
    const cancelBtn = modal.querySelector('.cancel-btn');
    const recipeForm = document.getElementById('recipe-form');
    const addIngredientBtn = document.getElementById('add-ingredient-btn');

    addRecipeBtn.addEventListener('click', () => {
        openRecipeModal();
    });

    closeBtn.addEventListener('click', () => {
        closeRecipeModal();
    });

    cancelBtn.addEventListener('click', () => {
        closeRecipeModal();
    });

    addIngredientBtn.addEventListener('click', () => {
        addIngredientField();
    });

    recipeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveRecipe();
    });

    document.getElementById('recipe-book-search').addEventListener('input', renderRecipes);

    renderRecipes();
}

function openRecipeModal(recipeId = null) {
    const modal = document.getElementById('recipe-modal');
    const form = document.getElementById('recipe-form');
    const modalTitle = document.getElementById('modal-title');

    form.reset();
    document.getElementById('ingredients-list').innerHTML = '';

    if (recipeId !== null) {
        modalTitle.textContent = 'Edit Recipe';
        const recipe = recipes[recipeId];
        document.getElementById('recipe-name').value = recipe.name;
        document.getElementById('recipe-servings').value = recipe.servings;
        document.getElementById('recipe-instructions').value = recipe.instructions || '';

        recipe.ingredients.forEach(ing => {
            addIngredientField(ing.quantity, ing.unit, ing.name);
        });

        form.dataset.editId = recipeId;
    } else {
        modalTitle.textContent = 'Add Recipe';
        delete form.dataset.editId;
        addIngredientField();
    }

    modal.classList.add('active');
}

function closeRecipeModal() {
    document.getElementById('recipe-modal').classList.remove('active');
}

function addIngredientField(quantity = '', unit = '', name = '') {
    const ingredientsList = document.getElementById('ingredients-list');
    const div = document.createElement('div');
    div.className = 'ingredient-item';
    div.innerHTML = `
        <input type="number" step="0.01" placeholder="Qty" value="${quantity}" style="width: 80px;">
        <input type="text" placeholder="Unit (cup, tbsp, etc)" value="${unit}" style="width: 120px;">
        <input type="text" placeholder="Ingredient name" value="${name}">
        <button type="button" onclick="this.parentElement.remove()">Remove</button>
    `;
    ingredientsList.appendChild(div);
}

function saveRecipe() {
    const form = document.getElementById('recipe-form');
    const name = document.getElementById('recipe-name').value;
    const servings = parseInt(document.getElementById('recipe-servings').value);
    const instructions = document.getElementById('recipe-instructions').value;

    const ingredientItems = document.querySelectorAll('.ingredient-item');
    const ingredients = [];

    ingredientItems.forEach(item => {
        const inputs = item.querySelectorAll('input');
        const quantity = parseFloat(inputs[0].value) || 0;
        const unit = inputs[1].value.trim().toLowerCase();
        const ingredientName = inputs[2].value.trim();

        if (quantity && ingredientName) {
            ingredients.push({ quantity, unit, name: ingredientName });
        }
    });

    const recipe = {
        name,
        servings,
        ingredients,
        instructions
    };

    if (form.dataset.editId !== undefined) {
        recipes[form.dataset.editId] = recipe;
    } else {
        recipes.push(recipe);
    }

    saveData();
    renderRecipes();
    renderSidebarRecipes();
    closeRecipeModal();
}

function renderRecipes() {
    const recipeList = document.getElementById('recipe-list');
    const searchTerm = (document.getElementById('recipe-book-search')?.value || '').toLowerCase().trim();

    if (recipes.length === 0) {
        recipeList.innerHTML = '<div class="empty-state">No recipes yet. Click "Add Recipe" to get started!</div>';
        return;
    }

    const filtered = recipes
        .map((recipe, index) => ({ recipe, index }))
        .filter(({ recipe }) => !searchTerm || recipe.name.toLowerCase().includes(searchTerm));

    if (filtered.length === 0) {
        recipeList.innerHTML = '<div class="empty-state">No recipes match your search.</div>';
        return;
    }

    recipeList.innerHTML = filtered.map(({ recipe, index }) => {
        const ingredientsPreview = recipe.ingredients.slice(0, 3).map(i => i.name).join(', ');
        const moreText = recipe.ingredients.length > 3 ? ` (+${recipe.ingredients.length - 3} more)` : '';

        return `
            <div class="recipe-card">
                <h3>${recipe.name}</h3>
                <div class="servings">Servings: ${recipe.servings}</div>
                <div class="ingredients-preview">${ingredientsPreview}${moreText}</div>
                <div class="actions">
                    <button class="btn-secondary" onclick="viewRecipe(${index})">View</button>
                    <button class="btn-secondary" onclick="openRecipeModal(${index})">Edit</button>
                    <button class="btn-danger" onclick="deleteRecipe(${index})">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

function viewRecipe(index) {
    const recipe = recipes[index];
    const ingredientsList = recipe.ingredients.map(i => `${i.quantity} ${i.unit} ${i.name}`).join('\n');

    alert(`${recipe.name}\n\nServings: ${recipe.servings}\n\nIngredients:\n${ingredientsList}\n\nInstructions:\n${recipe.instructions || 'No instructions provided'}`);
}

function deleteRecipe(index) {
    if (confirm('Are you sure you want to delete this recipe?')) {
        recipes.splice(index, 1);

        // Remove from meal plan
        Object.keys(mealPlan).forEach(memberId => {
            Object.keys(mealPlan[memberId]).forEach(day => {
                Object.keys(mealPlan[memberId][day]).forEach(meal => {
                    if (mealPlan[memberId][day][meal] > index) {
                        mealPlan[memberId][day][meal]--;
                    } else if (mealPlan[memberId][day][meal] === index) {
                        delete mealPlan[memberId][day][meal];
                    }
                });
            });
        });

        saveData();
        renderRecipes();
        renderSidebarRecipes();
    }
}

// Sidebar Recipes
function renderSidebarRecipes() {
    const sidebarList = document.getElementById('sidebar-recipe-list');
    const searchTerm = (document.getElementById('recipe-search')?.value || '').toLowerCase();

    // Update sort button label
    const sortBtn = document.getElementById('sidebar-sort-btn');
    if (sortBtn) sortBtn.textContent = SORT_LABELS[sidebarSortMode];

    const indexed = recipes.map((recipe, index) => ({ recipe, index }));

    const filtered = indexed.filter(({ recipe }) =>
        recipe.name.toLowerCase().includes(searchTerm)
    );

    const sorted = filtered.slice().sort((a, b) => {
        if (sidebarSortMode === 'az') return a.recipe.name.localeCompare(b.recipe.name);
        if (sidebarSortMode === 'za') return b.recipe.name.localeCompare(a.recipe.name);
        // recent: higher lastUsed timestamp first, unset recipes go to the end
        return (b.recipe.lastUsed || 0) - (a.recipe.lastUsed || 0);
    });

    if (sorted.length === 0) {
        sidebarList.innerHTML = '<div class="empty-state" style="padding: 20px;">No recipes found</div>';
        return;
    }

    sidebarList.innerHTML = sorted.map(({ recipe, index }) => `
        <div class="sidebar-recipe-item" draggable="true" data-recipe-id="${index}">
            <strong>${recipe.name}</strong>
            <div class="recipe-servings">Servings: ${recipe.servings}</div>
        </div>
    `).join('');

    document.querySelectorAll('.sidebar-recipe-item').forEach(item => {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragend', handleDragEnd);
    });
}

let draggedRecipeId = null;

function handleDragStart(e) {
    draggedRecipeId = parseInt(e.target.dataset.recipeId);
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'copy';
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
}

// Meal Plan
function initializeMealPlan() {
    document.getElementById('recipe-search').addEventListener('input', renderSidebarRecipes);

    document.getElementById('sidebar-sort-btn').addEventListener('click', () => {
        const idx = SORT_MODES.indexOf(sidebarSortMode);
        sidebarSortMode = SORT_MODES[(idx + 1) % SORT_MODES.length];
        renderSidebarRecipes();
    });

    renderMealPlan();
}

function renderMealPlan() {
    const mealPlanGrid = document.getElementById('meal-plan-grid');
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const member = householdMembers.find(m => m.id === currentMember);

    if (!member) return;

    const mealsPerDay = member.mealsPerDay || 3;

    // Create a table-like layout
    let html = '<div class="compact-meal-plan">';

    // Header row
    html += '<div class="plan-row plan-header">';
    html += '<div class="plan-cell day-label"></div>';
    for (let i = 0; i < mealsPerDay; i++) {
        html += `<div class="plan-cell meal-header">Meal ${i + 1}</div>`;
    }
    html += '</div>';

    // Day rows
    days.forEach(day => {
        html += '<div class="plan-row">';
        html += `<div class="plan-cell day-label">${day}</div>`;

        for (let mealNum = 0; mealNum < mealsPerDay; mealNum++) {
            const mealKey = `meal${mealNum}`;
            const assignedRecipeId = mealPlan[currentMember]?.[day]?.[mealKey];

            if (assignedRecipeId !== undefined) {
                const recipe = recipes[assignedRecipeId];
                html += `
                    <div class="plan-cell meal-slot" data-day="${day}" data-meal="${mealKey}">
                        <div class="assigned-recipe-compact">
                            <div class="recipe-name-compact">${recipe.name}</div>
                            <div class="recipe-actions-compact">
                                <button class="btn-icon" onclick="openQuickFill('${day}', '${mealKey}', ${assignedRecipeId})" title="Copy to other days">📋</button>
                                <button class="btn-icon btn-remove" onclick="removeMeal('${day}', '${mealKey}')" title="Remove">✕</button>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                html += `
                    <div class="plan-cell meal-slot empty-slot" data-day="${day}" data-meal="${mealKey}">
                        <span class="drop-hint">+</span>
                    </div>
                `;
            }
        }

        html += '</div>';
    });

    html += '</div>';
    mealPlanGrid.innerHTML = html;

    // Add drop event listeners
    document.querySelectorAll('.meal-slot').forEach(slot => {
        slot.addEventListener('dragover', handleDragOver);
        slot.addEventListener('drop', handleDrop);
        slot.addEventListener('dragleave', handleDragLeave);
    });
}

function handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    const day = e.currentTarget.dataset.day;
    const meal = e.currentTarget.dataset.meal;

    if (draggedRecipeId !== null) {
        assignMeal(day, meal, draggedRecipeId);
        draggedRecipeId = null;
    }
}

function assignMeal(day, meal, recipeId) {
    if (!mealPlan[currentMember]) {
        mealPlan[currentMember] = {};
    }
    if (!mealPlan[currentMember][day]) {
        mealPlan[currentMember][day] = {};
    }

    const id = parseInt(recipeId);
    mealPlan[currentMember][day][meal] = id;
    if (recipes[id]) recipes[id].lastUsed = Date.now();
    saveData();
    renderMealPlan();
}

function removeMeal(day, meal) {
    if (mealPlan[currentMember]?.[day]) {
        delete mealPlan[currentMember][day][meal];
        saveData();
        renderMealPlan();
    }
}

// Quick Fill
function openQuickFill(currentDay, currentMeal, recipeId) {
    const modal = document.getElementById('quick-fill-modal');
    const recipe = recipes[recipeId];
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const daysFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // Extract meal number from meal key (e.g., "meal0" -> 0)
    const mealNum = parseInt(currentMeal.replace('meal', ''));

    document.getElementById('quick-fill-recipe-name').textContent = `Copy "${recipe.name}" to:`;

    const daysContainer = document.getElementById('quick-fill-days');
    daysContainer.innerHTML = days.map((day, index) => `
        <label>
            <input type="checkbox" value="${day}" data-meal="${currentMeal}" ${day === currentDay ? 'disabled checked' : ''}>
            ${daysFull[index]} - Meal ${mealNum + 1}
            ${day === currentDay ? '(current)' : ''}
        </label>
    `).join('');

    modal.dataset.recipeId = recipeId;
    modal.classList.add('active');

    const confirmBtn = document.getElementById('confirm-quick-fill-btn');
    confirmBtn.onclick = confirmQuickFill;

    const closeBtn = modal.querySelector('.close');
    const cancelBtn = modal.querySelector('.cancel-btn');
    closeBtn.onclick = () => modal.classList.remove('active');
    cancelBtn.onclick = () => modal.classList.remove('active');
}

function confirmQuickFill() {
    const modal = document.getElementById('quick-fill-modal');
    const recipeId = parseInt(modal.dataset.recipeId);
    const checkedBoxes = document.querySelectorAll('#quick-fill-days input[type="checkbox"]:checked:not([disabled])');

    checkedBoxes.forEach(checkbox => {
        const day = checkbox.value;
        const meal = checkbox.dataset.meal;
        assignMeal(day, meal, recipeId);
    });

    modal.classList.remove('active');
}

// ─── Unit conversion ──────────────────────────────────────────────────────────
const UNIT_MAP = {
    // ── mass → g ──────────────────────────────────────────
    g: { base: 'mass', factor: 1 },
    gram: { base: 'mass', factor: 1 },
    grams: { base: 'mass', factor: 1 },
    kg: { base: 'mass', factor: 1000 },
    kilogram: { base: 'mass', factor: 1000 },
    kilograms: { base: 'mass', factor: 1000 },
    mg: { base: 'mass', factor: 0.001 },
    milligram: { base: 'mass', factor: 0.001 },
    milligrams: { base: 'mass', factor: 0.001 },
    oz: { base: 'mass', factor: 28.3495 },
    ounce: { base: 'mass', factor: 28.3495 },
    ounces: { base: 'mass', factor: 28.3495 },
    lb: { base: 'mass', factor: 453.592 },
    lbs: { base: 'mass', factor: 453.592 },
    pound: { base: 'mass', factor: 453.592 },
    pounds: { base: 'mass', factor: 453.592 },

    // ── volume → ml ───────────────────────────────────────
    ml: { base: 'volume', factor: 1 },
    milliliter: { base: 'volume', factor: 1 },
    millilitre: { base: 'volume', factor: 1 },
    milliliters: { base: 'volume', factor: 1 },
    millilitres: { base: 'volume', factor: 1 },
    l: { base: 'volume', factor: 1000 },
    liter: { base: 'volume', factor: 1000 },
    litre: { base: 'volume', factor: 1000 },
    liters: { base: 'volume', factor: 1000 },
    litres: { base: 'volume', factor: 1000 },
    tsp: { base: 'volume', factor: 4.92892 },
    teaspoon: { base: 'volume', factor: 4.92892 },
    teaspoons: { base: 'volume', factor: 4.92892 },
    tbsp: { base: 'volume', factor: 14.7868 },
    tablespoon: { base: 'volume', factor: 14.7868 },
    tablespoons: { base: 'volume', factor: 14.7868 },
    'fl oz': { base: 'volume', factor: 29.5735 },
    cup: { base: 'volume', factor: 240 },
    cups: { base: 'volume', factor: 240 },
    pt: { base: 'volume', factor: 473.176 },
    pint: { base: 'volume', factor: 473.176 },
    pints: { base: 'volume', factor: 473.176 },
    qt: { base: 'volume', factor: 946.353 },
    quart: { base: 'volume', factor: 946.353 },
    quarts: { base: 'volume', factor: 946.353 },
    gal: { base: 'volume', factor: 3785.41 },
    gallon: { base: 'volume', factor: 3785.41 },
    gallons: { base: 'volume', factor: 3785.41 },

    // ── length → cm ───────────────────────────────────────
    cm: { base: 'length', factor: 1 },
    mm: { base: 'length', factor: 0.1 },
    m: { base: 'length', factor: 100 },
    inch: { base: 'length', factor: 2.54 },
    inches: { base: 'length', factor: 2.54 },
    '"': { base: 'length', factor: 2.54 },
};

// Singular/plural pairs for count-based units
const COUNT_UNITS = {
    piece: 'pieces',
    pieces: 'pieces',
    slice: 'slices',
    slices: 'slices',
    strip: 'strips',
    strips: 'strips',
    sheet: 'sheets',
    sheets: 'sheets',
    clove: 'cloves',
    cloves: 'cloves',
    sprig: 'sprigs',
    sprigs: 'sprigs',
    leaf: 'leaves',
    leaves: 'leaves',
    stalk: 'stalks',
    stalks: 'stalks',
    fillet: 'fillets',
    fillets: 'fillets',
    can: 'cans',
    cans: 'cans',
    tin: 'tins',
    tins: 'tins',
    bag: 'bags',
    bags: 'bags',
    bunch: 'bunches',
    bunches: 'bunches',
    head: 'heads',
    heads: 'heads',
    loaf: 'loaves',
    loaves: 'loaves',
    egg: 'eggs',
    eggs: 'eggs',
    _singular: {
        pieces: 'piece', slices: 'slice', strips: 'strip', sheets: 'sheet',
        cloves: 'clove', sprigs: 'sprig', leaves: 'leaf', stalks: 'stalk',
        fillets: 'fillet', cans: 'can', tins: 'tin', bags: 'bag',
        bunches: 'bunch', heads: 'head', loaves: 'loaf', eggs: 'egg'
    }
};

function toBase(quantity, rawUnit) {
    const u = (rawUnit || '').trim().toLowerCase();
    if (!u) return { value: quantity, base: 'count', displayUnit: '' };

    const mapping = UNIT_MAP[u];
    if (mapping) {
        return { value: quantity * mapping.factor, base: mapping.base };
    }

    const pluralForm = COUNT_UNITS[u];
    if (pluralForm !== undefined) {
        return { value: quantity, base: 'count', countUnit: pluralForm };
    }

    return { value: quantity, base: 'unknown', displayUnit: u };
}

function formatMetric(value, base) {
    if (base === 'mass') {
        if (value >= 1000) return { amount: value / 1000, unit: 'kg' };
        return { amount: value, unit: 'g' };
    }
    if (base === 'volume') {
        if (value >= 1000) return { amount: value / 1000, unit: 'L' };
        return { amount: value, unit: 'ml' };
    }
    if (base === 'length') {
        if (value >= 100) return { amount: value / 100, unit: 'm' };
        return { amount: value, unit: 'cm' };
    }
    return null;
}

function formatNumber(num) {
    const rounded = Math.round(num * 100) / 100;
    return rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(2).replace(/\.?0+$/, '');
}

function aggregateIngredients() {
    const ingredientMap = new Map();

    householdMembers.forEach(member => {
        if (!mealPlan[member.id]) return;
        Object.keys(mealPlan[member.id]).forEach(day => {
            Object.keys(mealPlan[member.id][day]).forEach(meal => {
                const recipeId = mealPlan[member.id][day][meal];
                const recipe = recipes[recipeId];
                recipe.ingredients.forEach(ingredient => {
                    const key = ingredient.name.toLowerCase();
                    if (!ingredientMap.has(key)) {
                        ingredientMap.set(key, {
                            name: ingredient.name,
                            bases: { mass: 0, volume: 0, length: 0, count: {}, unknown: {} }
                        });
                    }
                    const entry = ingredientMap.get(key);
                    const converted = toBase(ingredient.quantity, ingredient.unit);

                    if (converted.base === 'mass') entry.bases.mass += converted.value;
                    else if (converted.base === 'volume') entry.bases.volume += converted.value;
                    else if (converted.base === 'length') entry.bases.length += converted.value;
                    else if (converted.base === 'count') {
                        const cu = converted.countUnit || 'pieces';
                        entry.bases.count[cu] = (entry.bases.count[cu] || 0) + converted.value;
                    } else {
                        const du = converted.displayUnit || '';
                        entry.bases.unknown[du] = (entry.bases.unknown[du] || 0) + converted.value;
                    }
                });
            });
        });
    });

    return ingredientMap;
}

function buildTotalString(bases) {
    const parts = [];

    if (bases.mass > 0) {
        const f = formatMetric(bases.mass, 'mass');
        parts.push(`${formatNumber(f.amount)} ${f.unit}`);
    }
    if (bases.volume > 0) {
        const f = formatMetric(bases.volume, 'volume');
        parts.push(`${formatNumber(f.amount)} ${f.unit}`);
    }
    if (bases.length > 0) {
        const f = formatMetric(bases.length, 'length');
        parts.push(`${formatNumber(f.amount)} ${f.unit}`);
    }
    Object.entries(bases.count).forEach(([pluralUnit, qty]) => {
        const singularMap = COUNT_UNITS._singular || {};
        const singular = singularMap[pluralUnit] || pluralUnit;
        const displayUnit = qty === 1 ? singular : pluralUnit;
        parts.push(`${formatNumber(qty)} ${displayUnit}`);
    });
    Object.entries(bases.unknown).forEach(([label, qty]) => {
        parts.push(`${formatNumber(qty)}${label ? ' ' + label : ''}`);
    });

    return parts.join(', ') || '—';
}

// ─── Shopping List UI ─────────────────────────────────────────────────────────
function initializeShoppingList() {
    document.getElementById('generate-list-btn').addEventListener('click', showPantryCheck);

    const addItemBtn = document.getElementById('add-item-btn');
    const addItemForm = document.getElementById('add-item-form');
    const cancelAddBtn = document.getElementById('cancel-add-item-btn');
    const confirmAddBtn = document.getElementById('confirm-add-item-btn');
    const nameInput = document.getElementById('custom-item-name');

    addItemBtn.addEventListener('click', () => {
        addItemForm.style.display = addItemForm.style.display === 'none' ? 'flex' : 'none';
        if (addItemForm.style.display === 'flex') nameInput.focus();
    });

    cancelAddBtn.addEventListener('click', () => {
        addItemForm.style.display = 'none';
        clearAddItemForm();
    });

    confirmAddBtn.addEventListener('click', addCustomShoppingItem);

    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addCustomShoppingItem();
    });
}

function clearAddItemForm() {
    document.getElementById('custom-item-name').value = '';
    document.getElementById('custom-item-qty').value = '';
    document.getElementById('custom-item-unit').value = '';
}

function addCustomShoppingItem() {
    const name = document.getElementById('custom-item-name').value.trim();
    if (!name) {
        document.getElementById('custom-item-name').focus();
        return;
    }

    const qty = document.getElementById('custom-item-qty').value.trim();
    const unit = document.getElementById('custom-item-unit').value.trim();
    const total = qty ? `${qty}${unit ? ' ' + unit : ''}` : '—';

    // If an item with the same name already exists, update it rather than duplicate
    const existing = shoppingList.findIndex(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing !== -1) {
        shoppingList[existing].total = total;
        shoppingList[existing].checked = false;
    } else {
        shoppingList.push({ name, total, checked: false, custom: true });
    }

    saveData();
    renderShoppingList();

    clearAddItemForm();
    document.getElementById('add-item-form').style.display = 'none';
}

function showPantryCheck() {
    const ingredientMap = aggregateIngredients();

    if (ingredientMap.size === 0) {
        alert('No meal plan set. Add recipes to your meal plan first!');
        return;
    }

    const modal = document.getElementById('pantry-modal');
    const pantryList = document.getElementById('pantry-check-list');

    const ingredients = Array.from(ingredientMap.values());

    pantryList.innerHTML = ingredients.map((ing, index) => {
        const totalStr = buildTotalString(ing.bases);
        const key = ing.name.toLowerCase();
        return `
            <div class="pantry-item" data-key="${key}">
                <div style="display:flex;align-items:center;gap:10px;">
                    <input type="checkbox" id="pantry-${index}" class="pantry-cb" onchange="togglePantryPartial('${key}')">
                    <label for="pantry-${index}" class="pantry-label">
                        <strong>${ing.name}</strong>
                        <span class="pantry-total">${totalStr}</span>
                    </label>
                </div>
                <div class="pantry-partial" id="partial-${index}" style="display:none;">
                    <label>I have:</label>
                    <input type="number" class="partial-qty" min="0" step="0.01" placeholder="amount">
                    <select class="partial-unit">${buildPartialUnitOptions(ing.bases)}</select>
                </div>
            </div>
        `;
    }).join('');

    modal.classList.add('active');

    const confirmBtn = document.getElementById('confirm-pantry-btn');
    confirmBtn.onclick = generateShoppingList;

    const closeBtn = modal.querySelector('.close');
    const cancelBtn = modal.querySelector('.cancel-btn');
    closeBtn.onclick = () => modal.classList.remove('active');
    cancelBtn.onclick = () => modal.classList.remove('active');
}

function buildPartialUnitOptions(bases) {
    const options = [];
    if (bases.mass > 0) {
        const f = formatMetric(bases.mass, 'mass');
        options.push(`<option value="${f.unit}">${f.unit}</option>`);
        if (f.unit === 'kg') options.push('<option value="g">g</option>');
        else options.push('<option value="kg">kg</option>');
    }
    if (bases.volume > 0) {
        const f = formatMetric(bases.volume, 'volume');
        options.push(`<option value="${f.unit}">${f.unit}</option>`);
        if (f.unit === 'L') options.push('<option value="ml">ml</option>');
        else options.push('<option value="L">L</option>');
    }
    if (bases.length > 0) {
        options.push('<option value="cm">cm</option>');
        options.push('<option value="m">m</option>');
    }
    Object.keys(bases.count).forEach(pluralUnit => {
        options.push(`<option value="${pluralUnit}">${pluralUnit}</option>`);
    });
    Object.keys(bases.unknown).forEach(label => {
        options.push(`<option value="${label}">${label || 'units'}</option>`);
    });
    return options.join('');
}

function togglePantryPartial(key) {
    const item = document.querySelector(`.pantry-item[data-key="${key}"]`);
    const cb = item.querySelector('.pantry-cb');
    const partialDiv = item.querySelector('.pantry-partial');
    partialDiv.style.display = cb.checked ? 'flex' : 'none';
    if (!cb.checked) {
        item.querySelector('.partial-qty').value = '';
    }
}

function generateShoppingList() {
    const modal = document.getElementById('pantry-modal');
    const ingredientMap = aggregateIngredients();

    const pantryRows = document.querySelectorAll('.pantry-item');
    const subtractions = new Map();

    pantryRows.forEach(row => {
        const key = row.dataset.key;
        const cb = row.querySelector('.pantry-cb');
        if (!cb.checked) return;

        const partialQtyEl = row.querySelector('.partial-qty');
        const partialUnitEl = row.querySelector('.partial-unit');
        const partialQty = parseFloat(partialQtyEl?.value);

        if (!isNaN(partialQty) && partialQty > 0 && partialUnitEl) {
            const converted = toBase(partialQty, partialUnitEl.value);
            const sub = { mass: 0, volume: 0, length: 0, count: {}, unknown: {} };
            if (converted.base === 'mass') sub.mass = converted.value;
            else if (converted.base === 'volume') sub.volume = converted.value;
            else if (converted.base === 'length') sub.length = converted.value;
            else if (converted.base === 'count') sub.count[converted.countUnit || 'pieces'] = converted.value;
            else sub.unknown[converted.displayUnit || ''] = converted.value;
            subtractions.set(key, sub);
        } else {
            subtractions.set(key, 'all');
        }
    });

    modal.classList.remove('active');

    const result = [];

    ingredientMap.forEach((ing, key) => {
        const sub = subtractions.get(key);

        if (sub === 'all') return;

        const bases = {
            mass: ing.bases.mass,
            volume: ing.bases.volume,
            length: ing.bases.length,
            count: { ...ing.bases.count },
            unknown: { ...ing.bases.unknown }
        };

        if (sub) {
            bases.mass = Math.max(0, bases.mass - (sub.mass || 0));
            bases.volume = Math.max(0, bases.volume - (sub.volume || 0));
            bases.length = Math.max(0, bases.length - (sub.length || 0));
            Object.entries(sub.count).forEach(([u, v]) => {
                bases.count[u] = Math.max(0, (bases.count[u] || 0) - v);
                if (bases.count[u] === 0) delete bases.count[u];
            });
            Object.entries(sub.unknown).forEach(([u, v]) => {
                bases.unknown[u] = Math.max(0, (bases.unknown[u] || 0) - v);
                if (bases.unknown[u] === 0) delete bases.unknown[u];
            });
        }

        const totalRemaining = bases.mass + bases.volume + bases.length
            + Object.values(bases.count).reduce((a, b) => a + b, 0)
            + Object.values(bases.unknown).reduce((a, b) => a + b, 0);
        if (totalRemaining <= 0) return;

        result.push({ name: ing.name, total: buildTotalString(bases), checked: false });
    });

    // Preserve any custom items added manually, then replace the rest
    const customItems = shoppingList.filter(i => i.custom);
    shoppingList = [...result, ...customItems];
    saveData();
    renderShoppingList();
}

function renderShoppingList() {
    const shoppingListContent = document.getElementById('shopping-list-content');

    if (shoppingList.length === 0) {
        shoppingListContent.innerHTML = '<div class="empty-state">No shopping list yet. Generate one from your meal plan!</div>';
        return;
    }

    shoppingListContent.innerHTML = `
        <div class="ingredient-group">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3>Shopping List (${shoppingList.length} item${shoppingList.length !== 1 ? 's' : ''})</h3>
                <button id="clear-list-btn" class="btn-secondary">Clear List</button>
            </div>
            ${shoppingList.map((ing, index) => `
                <div class="ingredient-checkbox${ing.checked ? ' checked' : ''}" data-index="${index}">
                    <input type="checkbox" id="shop-${index}"${ing.checked ? ' checked' : ''}>
                    <label for="shop-${index}">
                        <strong>${ing.name}</strong> — ${ing.total}
                    </label>
                </div>
            `).join('')}
        </div>
    `;

    document.querySelectorAll('#shopping-list-content input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', function () {
            const idx = parseInt(this.closest('.ingredient-checkbox').dataset.index, 10);
            shoppingList[idx].checked = this.checked;
            this.parentElement.classList.toggle('checked', this.checked);
            saveData();
        });
    });

    document.getElementById('clear-list-btn').addEventListener('click', () => {
        shoppingList = [];
        saveData();
        renderShoppingList();
    });
}
