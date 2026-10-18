import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from google import genai

app = FastAPI(title="NebulaAI - DEV HACKERS")

MESSAGES_DB = []

class ChatRequest(BaseModel):
    message: str
    mode: str = "general"

class ContactRequest(BaseModel):
    message: str

@app.post("/api/chat")
async def chat_with_gemini(req: ChatRequest):
    try:
        # Vérifie si la clé API est bien présente dans l'environnement Render
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return {"result": "Erreur critique : La variable d'environnement 'GEMINI_API_KEY' est introuvable sur Render. Ajoute-la dans tes paramètres de déploiement."}

        client = genai.Client(api_key=api_key)
        
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
        return {"result": f"Erreur de l'API Gemini : {str(e)}"}

@app.post("/api/contact")
async def contact_admin(req: ContactRequest):
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
