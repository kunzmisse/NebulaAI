import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from google import genai

app = FastAPI(title="NebulaAI - DEV HACKERS")

# Initialisation propre du client Google GenAI (récupère automatiquement la variable d'environnement GEMINI_API_KEY sur Render)
client = genai.Client()

MESSAGES_DB = []

class ChatRequest(BaseModel):
    message: str
    mode: str = "general"

class ContactRequest(BaseModel):
    message: str

@app.post("/api/chat")
async def chat_with_gemini(req: ChatRequest):
    try:
        if not req.message.strip():
            raise HTTPException(status_code=400, detail="Le message est vide.")
            
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
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message vide.")
    MESSAGES_DB.append({"message": req.message})
    return {"status": "success", "message": "Votre message a bien été transmis."}

@app.get("/api/admin/data")
async def get_admin_data(admin_key: str):
    if admin_key != "devhackers2026":
        raise HTTPException(status_code=403, detail="Clé administrateur invalide.")
    return {"messages": MESSAGES_DB}

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_index():
    return FileResponse("static/index.html")
