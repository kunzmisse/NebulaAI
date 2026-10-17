import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
from google import genai

app = FastAPI(title="NebulaAI - DEV HACKERS")

client = genai.Client()

# Stockage en mémoire pour la démo (utilisateurs, messages de contact, bannissements)
USERS_DB = []
MESSAGES_DB = []
BANNED_NUMBERS = set()

class RegisterRequest(BaseModel):
    name: str
    phone: str

class ChatRequest(BaseModel):
    message: str
    mode: str = "general" # "general", "roast", "fix"
    phone: str

class ContactRequest(BaseModel):
    phone: str
    message: str

class AdminActionRequest(BaseModel):
    target: str # phone ou id
    action: str # "ban", "unban", "suspend"

@app.post("/api/register")
async def register_user(req: RegisterRequest):
    if req.phone in BANNED_NUMBERS:
        raise HTTPException(status_code=403, detail="Accès refusé : Ce compte a été banni par l'administrateur.")
    
    # Enregistrer ou mettre à jour l'utilisateur
    user_data = {"name": req.name, "phone": req.phone, "status": "actif"}
    if not any(u["phone"] == req.phone for u in USERS_DB):
        USERS_DB.append(user_data)
    return {"status": "success", "message": f"Bienvenue dans NebulaAI, {req.name} !"}

@app.post("/api/chat")
async def chat_with_gemini(req: ChatRequest):
    if req.phone in BANNED_NUMBERS:
        raise HTTPException(status_code=403, detail="Votre accès a été suspendu ou banni par DEV HACKERS.")
    
    try:
        clean_msg = req.message.encode('ascii', 'ignore').decode('ascii')
        
        if req.mode == "roast":
            prompt = f"Agis en tant que développeur senior cynique, arrogant mais brillant de l'équipe DEV HACKERS. Fais un 'roast' hilarant et piquant de ceci :\n\n{clean_msg}"
        elif req.mode == "fix":
            prompt = f"Agis en tant qu'architecte logiciel expert de NebulaAI (créé par DEV HACKERS). Corrige et optimise ceci :\n\n{clean_msg}"
        else:
            prompt = f"Tu es NebulaAI, une intelligence artificielle conversationnelle haut de gamme développée par DEV HACKERS. Réponds de manière intelligente, élégante, percutante et utile à la requête suivante :\n\n{clean_msg}"

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )
        return {"result": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/contact")
async def contact_admin(req: ContactRequest):
    MESSAGES_DB.append({"phone": req.phone, "message": req.message})
    return {"status": "success", "message": "Votre message a été transmis à l'administrateur DEV HACKERS."}

@app.get("/api/admin/data")
async def get_admin_data(admin_key: str):
    # Clé secrète admin simple pour la démo
    if admin_key != "devhackers2026":
        raise HTTPException(status_code=403, detail="Clé administrateur invalide.")
    return {
        "users": USERS_DB,
        "messages": MESSAGES_DB,
        "banned": list(BANNED_NUMBERS)
    }

@app.post("/api/admin/action")
async def admin_action(req: AdminActionRequest, admin_key: str):
    if admin_key != "devhackers2026":
        raise HTTPException(status_code=403, detail="Non autorisé.")
    
    if req.action == "ban":
        BANNED_NUMBERS.add(req.target)
        for u in USERS_DB:
            if u["phone"] == req.target:
                u["status"] = "banni"
    elif req.action == "unban":
        if req.target in BANNED_NUMBERS:
            BANNED_NUMBERS.remove(req.target)
        for u in USERS_DB:
            if u["phone"] == req.target:
                u["status"] = "actif"
    return {"status": "success"}

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_index():
    return FileResponse("static/index.html")
