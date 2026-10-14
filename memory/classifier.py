"""Opt-in Jev suggestions; never silently replace repository evidence."""
import math
from .privacy import text


def decide(response, candidates, threshold=0.85, margin=0.20):
    answer = response.get("answers",{}).get("project",{})
    probs = answer.get("probabilities",{})
    allowed = set(candidates) | {"unresolved"}
    if answer.get("type") != "choice" or set(probs) != allowed:
        raise ValueError("Jev returned an invalid choice distribution")
    if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and 0<=v<=1 for v in probs.values()):
        raise ValueError("invalid Jev probabilities")
    if abs(sum(probs.values())-1)>0.02:
        raise ValueError("Jev probabilities do not sum to one")
    ordered = sorted(probs.items(),key=lambda pair:pair[1],reverse=True)
    choice, probability = ordered[0]
    confidence = answer.get("confidence")
    if (answer.get("choice") != choice or not isinstance(confidence,(int,float))
            or isinstance(confidence,bool) or not math.isfinite(confidence) or not 0<=confidence<=1):
        raise ValueError("invalid Jev confidence/choice")
    gap = probability-ordered[1][1] if len(ordered)>1 else probability
    return {"suggested_project":choice if choice!="unresolved" and probability>=threshold and confidence>=threshold and gap>=margin else None,
            "choice":choice,"probability":probability,"confidence":confidence,"margin":gap,
            "probabilities":probs,"model":response.get("model"),"status":"review",
            "threshold":threshold,"minimum_margin":margin}


def suggest(store, authorities, intent_id, summary, name="typesafe.jev", model="jev-latest"):
    # The operator explicitly invokes this and has granted the authority to this project.
    projects = store.projects()[:30]
    candidates = {p["id"]:{"name":p["name"],"description":p["description"],"repository":p["repository"]} for p in projects}
    request = {"model":model,"state":text(summary),"questions":{"project":{
        "type":"choice","instructions":"Associate the activity with one known project; use unresolved if evidence is insufficient.",
        "criteria":{**candidates,"unresolved":"Ambiguous, unrelated or insufficient evidence"}}}}
    result = authorities.call(name,intent_id,"/v1/systemone",method="POST",body=request)
    if result["status"]!=200:
        raise RuntimeError("Jev request failed")
    suggestion = decide(result["data"],candidates)
    intent = store.intent(intent_id)
    store.record("classifier","jev","project.suggested","Jev association requires review",suggestion,
                 project_id=intent["project_id"])
    return suggestion
