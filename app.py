import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from google import genai

app = FastAPI(title="NebulaAI - DEV NEBULA")

# Initialisation du client Gemini via la variable d'environnement Render (GEMINI_API_KEY)
client = genai.Client()

class CodeRequest(BaseModel):
    code: str
    mode: str  # "roast" ou "fix"

@app.post("/api/process")
async def process_code(req: CodeRequest):
    try:
        if req.mode == "roast":
            prompt = f"Agis en tant que développeur senior cynique, arrogant mais brillant de l'équipe NebulaAI. Fais un 'roast' hilarant, technique et ultra-piquant de ce code :\n\n{req.code}"
        else:
            prompt = f"Agis en tant qu'architecte logiciel expert de NebulaAI. Corrige, optimise et commente proprement ce code en expliquant tes choix :\n\n{req.code}"

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )
        return {"result": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Servir l'interface web statique
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_index():
    return FileResponse("static/index.html")
